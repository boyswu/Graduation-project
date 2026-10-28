"""Minimal CatVTON inference wrapper for the live try-on service.

The model implementation follows the CatVTON reference repository:
https://github.com/Zheng-Chong/CatVTON (CC BY-NC-SA 4.0).
"""

from __future__ import annotations

import inspect
import hashlib
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import torch
import torch.nn.functional as F
from accelerate import load_checkpoint_in_model
from diffusers import AutoencoderKL, DDIMScheduler, UNet2DConditionModel
from diffusers.utils.torch_utils import randn_tensor
from PIL import Image, ImageFilter


class SkipAttnProcessor(torch.nn.Module):
    """CatVTON removes text cross-attention by returning the residual input."""

    def __init__(self, *args, **kwargs) -> None:
        super().__init__()

    def __call__(
        self,
        attn,
        hidden_states,
        encoder_hidden_states=None,
        attention_mask=None,
        temb=None,
        **kwargs,
    ):
        del attn, encoder_hidden_states, attention_mask, temb, kwargs
        return hidden_states


class CatVTONAttnProcessor2_0(torch.nn.Module):
    """Equivalent to the self-attention processor shipped by CatVTON."""

    def __init__(self, *args, **kwargs) -> None:
        super().__init__()

    def __call__(
        self,
        attn,
        hidden_states,
        encoder_hidden_states=None,
        attention_mask=None,
        temb=None,
        **kwargs,
    ):
        del kwargs
        residual = hidden_states
        if attn.spatial_norm is not None:
            hidden_states = attn.spatial_norm(hidden_states, temb)

        input_ndim = hidden_states.ndim
        if input_ndim == 4:
            batch_size, channel, height, width = hidden_states.shape
            hidden_states = hidden_states.view(
                batch_size, channel, height * width
            ).transpose(1, 2)

        batch_size, sequence_length, _ = (
            hidden_states.shape
            if encoder_hidden_states is None
            else encoder_hidden_states.shape
        )
        if attention_mask is not None:
            attention_mask = attn.prepare_attention_mask(
                attention_mask, sequence_length, batch_size
            )
            attention_mask = attention_mask.view(
                batch_size, attn.heads, -1, attention_mask.shape[-1]
            )
        if attn.group_norm is not None:
            hidden_states = attn.group_norm(
                hidden_states.transpose(1, 2)
            ).transpose(1, 2)

        query = attn.to_q(hidden_states)
        if encoder_hidden_states is None:
            encoder_hidden_states = hidden_states
        elif attn.norm_cross:
            encoder_hidden_states = attn.norm_encoder_hidden_states(
                encoder_hidden_states
            )
        key = attn.to_k(encoder_hidden_states)
        value = attn.to_v(encoder_hidden_states)
        inner_dim = key.shape[-1]
        head_dim = inner_dim // attn.heads
        query = query.view(batch_size, -1, attn.heads, head_dim).transpose(1, 2)
        key = key.view(batch_size, -1, attn.heads, head_dim).transpose(1, 2)
        value = value.view(batch_size, -1, attn.heads, head_dim).transpose(1, 2)
        hidden_states = F.scaled_dot_product_attention(
            query,
            key,
            value,
            attn_mask=attention_mask,
            dropout_p=0.0,
            is_causal=False,
        )
        hidden_states = hidden_states.transpose(1, 2).reshape(
            batch_size, -1, attn.heads * head_dim
        )
        hidden_states = hidden_states.to(query.dtype)
        hidden_states = attn.to_out[0](hidden_states)
        hidden_states = attn.to_out[1](hidden_states)
        if input_ndim == 4:
            hidden_states = hidden_states.transpose(-1, -2).reshape(
                batch_size, channel, height, width
            )
        if attn.residual_connection:
            hidden_states = hidden_states + residual
        return hidden_states / attn.rescale_output_factor


def init_adapter(unet: UNet2DConditionModel) -> None:
    """Install CatVTON's trainable self-attention and skip cross-attention."""
    processors: dict[str, torch.nn.Module] = {}
    for name in unet.attn_processors.keys():
        cross_attention_dim = (
            None if name.endswith("attn1.processor") else unet.config.cross_attention_dim
        )
        if name.startswith("mid_block"):
            hidden_size = unet.config.block_out_channels[-1]
        elif name.startswith("up_blocks"):
            block_id = int(name[len("up_blocks.")])
            hidden_size = list(reversed(unet.config.block_out_channels))[block_id]
        elif name.startswith("down_blocks"):
            block_id = int(name[len("down_blocks.")])
            hidden_size = unet.config.block_out_channels[block_id]
        else:
            raise ValueError(f"Unsupported attention module: {name}")

        if cross_attention_dim is None:
            processors[name] = CatVTONAttnProcessor2_0(
                hidden_size=hidden_size,
                cross_attention_dim=cross_attention_dim,
            )
        else:
            processors[name] = SkipAttnProcessor(
                hidden_size=hidden_size,
                cross_attention_dim=cross_attention_dim,
            )
    unet.set_attn_processor(processors)


def trainable_attention_modules(unet: UNet2DConditionModel) -> torch.nn.ModuleList:
    modules: list[torch.nn.Module] = []
    for name, module in unet.named_modules():
        if "attn1" in name:
            modules.append(module)
    return torch.nn.ModuleList(modules)


def resize_and_crop(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    width, height = image.size
    target_width, target_height = size
    if width / height < target_width / target_height:
        crop_width = width
        crop_height = round(width * target_height / target_width)
    else:
        crop_height = height
        crop_width = round(height * target_width / target_height)
    left = (width - crop_width) // 2
    top = (height - crop_height) // 2
    return image.crop((left, top, left + crop_width, top + crop_height)).resize(
        size, Image.Resampling.LANCZOS
    )


def prepare_image(image: Image.Image, device: torch.device, dtype: torch.dtype):
    pixels = np.asarray(image.convert("RGB"), dtype=np.float32) / 127.5 - 1.0
    tensor = torch.from_numpy(pixels).permute(2, 0, 1).unsqueeze(0)
    return tensor.to(device=device, dtype=dtype)


def prepare_mask(mask: Image.Image, device: torch.device, dtype: torch.dtype):
    values = np.asarray(mask.convert("L"), dtype=np.float32) / 255.0
    values = (values >= 0.5).astype(np.float32)
    tensor = torch.from_numpy(values)[None, None]
    return tensor.to(device=device, dtype=dtype)


def encode_image(vae: AutoencoderKL, image: torch.Tensor, generator=None) -> torch.Tensor:
    with torch.no_grad():
        latent = vae.encode(image).latent_dist.sample(generator=generator)
    return latent * vae.config.scaling_factor


@dataclass
class InferenceResult:
    image: Image.Image
    garment_layer: Image.Image
    timings_ms: dict[str, float]
    seed: int
    output_size: tuple[int, int]


class CatVTONRuntime:
    """Pinned CatVTON pipeline optimized for repeated camera keyframes."""

    def __init__(
        self,
        model_root: Path,
        device: str = "cuda",
        dtype: torch.dtype = torch.bfloat16,
    ):
        self.model_root = Path(model_root)
        self.device = torch.device(device)
        self.dtype = dtype
        self._garment_cache = None
        self.base_dir = self.model_root / "stable-diffusion-inpainting"
        self.vae_dir = self.model_root / "sd-vae-ft-mse"
        self.adapter_path = (
            self.model_root / "mix-48k-1024" / "attention" / "model.safetensors"
        )
        self._validate_paths()
        self.load_started_at = time.perf_counter()

        torch.set_float32_matmul_precision("high")
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True

        self.scheduler = DDIMScheduler.from_pretrained(
            self.base_dir, subfolder="scheduler"
        )
        self.vae = AutoencoderKL.from_pretrained(
            self.vae_dir,
            torch_dtype=dtype,
            low_cpu_mem_usage=True,
        )
        self.unet = UNet2DConditionModel.from_pretrained(
            self.base_dir,
            subfolder="unet",
            torch_dtype=dtype,
            low_cpu_mem_usage=True,
        )
        init_adapter(self.unet)
        adapter_modules = trainable_attention_modules(self.unet)
        load_checkpoint_in_model(adapter_modules, str(self.adapter_path))

        self.unet.to(device=self.device, dtype=self.dtype).eval()
        self.vae.to(device=self.device, dtype=self.dtype).eval()
        self.unet.requires_grad_(False)
        self.vae.requires_grad_(False)
        if self.device.type == "cuda":
            torch.cuda.empty_cache()
        self.load_ms = (time.perf_counter() - self.load_started_at) * 1000

    def _validate_paths(self) -> None:
        required = [
            self.base_dir / "scheduler" / "scheduler_config.json",
            self.base_dir / "unet" / "config.json",
            self.base_dir
            / "unet"
            / "diffusion_pytorch_model.safetensors",
            self.vae_dir / "config.json",
            self.vae_dir / "diffusion_pytorch_model.safetensors",
            self.adapter_path,
        ]
        missing = [str(path) for path in required if not path.exists()]
        if missing:
            raise FileNotFoundError(
                "CatVTON model files are incomplete. Missing: " + ", ".join(missing)
            )

    @torch.inference_mode()
    def infer(
        self,
        person: Image.Image,
        garment: Image.Image,
        mask: Image.Image,
        *,
        width: int = 512,
        height: int = 768,
        steps: int = 8,
        guidance_scale: float = 1.0,
        seed: int = 42,
    ) -> InferenceResult:
        def sync():
            if self.device.type == "cuda":
                torch.cuda.synchronize(self.device)

        sync()
        started = time.perf_counter()
        width = max(256, int(round(width / 8) * 8))
        height = max(256, int(round(height / 8) * 8))
        target_size = (width, height)

        person = resize_and_crop(person.convert("RGB"), target_size)
        mask = resize_and_crop(mask.convert("L"), target_size)
        garment = resize_and_padding(garment.convert("RGB"), target_size)
        garment_key = (target_size, int(seed), hashlib.sha256(garment.tobytes()).digest())
        prep_ms = (time.perf_counter() - started) * 1000

        encode_started = time.perf_counter()
        person_tensor = prepare_image(person, self.device, self.dtype)
        mask_tensor = prepare_mask(mask, self.device, self.dtype)
        masked_image = person_tensor * (mask_tensor < 0.5)
        generator = torch.Generator(device=self.device).manual_seed(int(seed))
        masked_latent = encode_image(self.vae, masked_image, generator)
        garment_cache_hit = self._garment_cache is not None and self._garment_cache[0] == garment_key
        if garment_cache_hit:
            condition_latent = self._garment_cache[1]
        else:
            garment_tensor = prepare_image(garment, self.device, self.dtype)
            garment_generator = torch.Generator(device=self.device).manual_seed(int(seed))
            condition_latent = encode_image(self.vae, garment_tensor, garment_generator)
            self._garment_cache = (garment_key, condition_latent)
        mask_latent = F.interpolate(
            mask_tensor, size=masked_latent.shape[-2:], mode="nearest"
        )
        masked_latent_concat = torch.cat([masked_latent, condition_latent], dim=-2)
        mask_latent_concat = torch.cat(
            [mask_latent, torch.zeros_like(mask_latent)], dim=-2
        )
        sync()
        encode_ms = (time.perf_counter() - encode_started) * 1000

        generator = torch.Generator(device=self.device).manual_seed(int(seed))
        latents = randn_tensor(
            masked_latent_concat.shape,
            generator=generator,
            device=self.device,
            dtype=self.dtype,
        )
        self.scheduler.set_timesteps(int(steps), device=self.device)
        latents = latents * self.scheduler.init_noise_sigma

        do_cfg = guidance_scale > 1.0
        if do_cfg:
            uncond_input = torch.cat(
                [masked_latent, torch.zeros_like(condition_latent)], dim=-2
            )
            model_condition = torch.cat([uncond_input, masked_latent_concat])
            model_mask = torch.cat([mask_latent_concat] * 2)
        else:
            model_condition = masked_latent_concat
            model_mask = mask_latent_concat

        extra_kwargs: dict[str, Any] = {}
        if "eta" in inspect.signature(self.scheduler.step).parameters:
            extra_kwargs["eta"] = 1.0
        if "generator" in inspect.signature(self.scheduler.step).parameters:
            extra_kwargs["generator"] = generator

        denoise_started = time.perf_counter()
        for timestep in self.scheduler.timesteps:
            model_input = torch.cat([latents] * (2 if do_cfg else 1))
            model_input = self.scheduler.scale_model_input(model_input, timestep)
            model_input = torch.cat(
                [model_input, model_mask, model_condition], dim=1
            )
            noise_pred = self.unet(
                model_input,
                timestep.to(self.device),
                encoder_hidden_states=None,
                return_dict=False,
            )[0]
            if do_cfg:
                noise_uncond, noise_cond = noise_pred.chunk(2)
                noise_pred = noise_uncond + guidance_scale * (
                    noise_cond - noise_uncond
                )
            latents = self.scheduler.step(
                noise_pred, timestep, latents, **extra_kwargs
            ).prev_sample
        sync()
        denoise_ms = (time.perf_counter() - denoise_started) * 1000

        decode_started = time.perf_counter()
        latents = latents.split(latents.shape[-2] // 2, dim=-2)[0]
        latents = latents / self.vae.config.scaling_factor
        decoded = self.vae.decode(
            latents.to(dtype=self.dtype), return_dict=False
        )[0]
        decoded = (decoded / 2 + 0.5).clamp(0, 1)
        decoded = decoded[0].permute(1, 2, 0).float().cpu().numpy()
        result = Image.fromarray((decoded * 255).round().astype(np.uint8))
        decode_ms = (time.perf_counter() - decode_started) * 1000

        layer_started = time.perf_counter()
        result_rgba = result.convert("RGBA")
        alpha = mask.filter(ImageFilter.GaussianBlur(radius=max(1, width // 160)))
        result_rgba.putalpha(alpha)
        layer_ms = (time.perf_counter() - layer_started) * 1000

        total_ms = (time.perf_counter() - started) * 1000
        timings = {
            "preprocess": prep_ms,
            "encode": encode_ms,
            "denoise": denoise_ms,
            "decode": decode_ms,
            "layer": layer_ms,
            "total": total_ms,
            "per_step": denoise_ms / max(1, steps),
            "garment_cache_hit": garment_cache_hit,
        }
        return InferenceResult(
            image=result,
            garment_layer=result_rgba,
            timings_ms=timings,
            seed=int(seed),
            output_size=(width, height),
        )

    def gpu_metrics(self) -> dict[str, float]:
        if self.device.type != "cuda":
            return {}
        return {
            "allocated_mb": torch.cuda.memory_allocated(self.device) / 1024**2,
            "reserved_mb": torch.cuda.memory_reserved(self.device) / 1024**2,
            "peak_mb": torch.cuda.max_memory_allocated(self.device) / 1024**2,
        }


def resize_and_padding(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    target_width, target_height = size
    width, height = image.size
    if width / height < target_width / target_height:
        new_height = target_height
        new_width = round(width * target_height / height)
    else:
        new_width = target_width
        new_height = round(height * target_width / width)
    image = image.resize((new_width, new_height), Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", size, (255, 255, 255))
    canvas.paste(image, ((target_width - new_width) // 2, (target_height - new_height) // 2))
    return canvas
