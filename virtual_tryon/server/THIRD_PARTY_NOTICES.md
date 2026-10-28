# Third-party notices

## CatVTON

- Project: CatVTON, https://github.com/Zheng-Chong/CatVTON
- Paper: Concatenation Is All You Need for Virtual Try-On with Diffusion Models
- License: CC BY-NC-SA 4.0
- Use in this project: non-commercial undergraduate research and demonstration.

`catvton_engine.py` is a reduced inference implementation derived from the
reference pipeline. It replaces the upstream Gradio application and mask
generation while retaining the CatVTON UNet adapter, DDIM sampling and the
concatenated garment conditioning described by the authors.

The weights are stored outside this repository and are not redistributed.

## Full-frame generation and optional interpolation

- FLUX.2 Klein 4B: Black Forest Labs, https://huggingface.co/black-forest-labs/FLUX.2-klein-4B (Apache-2.0).
- FluxRT: https://github.com/tensorforger/FluxRT, commit `32206e8255b085b9075e05d389781bcbc728d513` (Unlicense).
- RIFE v4.25 lite weights: official Comfy-Org repackaging, https://modelscope.cn/models/Comfy-Org/frame_interpolation. Model card lists `mit-and-apache-2.0`; upstream RIFE is linked there.
- Standalone IFNet runtime: https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/frame_interpolation_models/ifnet.py. ComfyUI source license is GPL-3.0; its complete license is retained alongside the remotely deployed source as `RIFE-safetensors/LICENSE.txt`. The sole adaptation replaces `comfy.ops.disable_weight_init` with ordinary `torch.nn` layers; inference math is retained.

The interpolation code/weights remain outside this repository, under the
isolated remote runtime. `RIFE-safetensors/manifest.json` records source and
adapted-source SHA256 values and the verified weight SHA256. This optional
model produces intermediate full-person frames; it does not generate new
garment-conditioned diffusion frames and must not be counted as native FPS.

## Additional garment reference samples

The five added demo reference photos are copied, unchanged, from the official
CatVTON and IDM-VTON example directories for this research demonstration.
Pinned source URLs, commits and SHA256 values are recorded in
`public/garments/products/additional-sources.json`.

- Look 04: CatVTON `resource/demo/example/condition/upper/23255574_53383833_1000.jpg`.
- Looks 05–08: IDM-VTON `gradio_demo/example/cloth/04469_00.jpg`, `09133_00.jpg`, `09163_00.jpg`, `09236_00.jpg` at https://github.com/yisol/IDM-VTON.

Repository licenses do not constitute an additional grant for pictured product
brands or characters. Uploaded garment images remain in browser memory and
are sent only to the selected try-on runtime when generating; the service does
not store them on disk.
