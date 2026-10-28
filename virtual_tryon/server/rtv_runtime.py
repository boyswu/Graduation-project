"""Isolated, headless RTV evaluation; this is not the production generator.

Run in its own process with the official RTV checkout and fixed-garment weights.
RTV synthesizes an RGBA garment and composites it over the original image. It
does not erase the original clothes. A successful call is not proof of quality.
"""

from pathlib import Path
import os
import sys
import threading
import time


class FixedGarmentRuntime:
    def __init__(self, root, runtime_dir, garment="lab_03_vmsdp2ta"):
        if garment not in {
            "lab_03_vmsdp2ta", "lab_04_vmsdp2ta", "lab_07_vmsdp2ta",
            "jin_17_vmsdp2ta", "jin_18_vmsdp2ta", "jin_22_vmsdp2ta",
            "coat_seq_vmssdp2ta_576", "han_seq_vmssdp2ta_576",
        }:
            raise ValueError("This probe requires an official fixed-garment ID")
        self.owner_thread = threading.get_ident()
        self.frame_shape = None
        self.root = Path(root).resolve()
        self.runtime_dir = Path(runtime_dir).resolve()
        self.runtime_dir.mkdir(parents=True, exist_ok=True)
        self.garment = garment
        checkpoint = self.root / "checkpoints" / garment / "latest_net_G.pth"
        if not checkpoint.is_file() or checkpoint.stat().st_size < 1_000_000:
            raise FileNotFoundError(f"Missing fixed garment checkpoint: {checkpoint}")

        # ROMP evaluates default settings at import time, including unused ROMP
        # models. Resolve their official downloads locally, without network I/O.
        home = self.runtime_dir / "home"
        model_home = home / ".romp"
        model_home.mkdir(parents=True, exist_ok=True)
        for name in ("BEV.pth", "smpla_packed_info.pth", "smil_packed_info.pth"):
            source = self.root / "models" / "romp" / name
            if not source.is_file() or source.stat().st_size < 1_000_000:
                raise FileNotFoundError(f"Missing body model: {source}")
            target = model_home / name
            if not target.exists():
                target.symlink_to(source)
        os.environ["HOME"] = str(home)
        os.environ["PYOPENGL_PLATFORM"] = "egl"
        # Our isolated ROMP fork patch defers its unused, eager ROMP downloads.
        os.environ["RTV_BEV_ONLY"] = "1"
        os.environ["TORCH_HOME"] = str(self.runtime_dir / "torch-cache")
        sys.path.insert(0, str(self.root / "source"))
        os.chdir(self.root / "source")  # upstream uses relative asset paths

        import torch
        import cv2
        import numpy as np
        import romp
        import bev
        torch.set_num_threads(4)
        cv2.setNumThreads(1)
        # No GUI/mesh visualization; preserve SMPL computation for garment pose.
        if romp.main.default_settings is not None:
            romp.main.default_settings.render_mesh = False
        bev.main.default_settings.render_mesh = False
        import model.DensePose.densepose_extractor as densepose
        default_predictor = densepose.DefaultPredictor
        local_weights = self.root / "models" / "densepose.pkl"

        def local_predictor(config):
            config = config.clone()
            config.defrost()
            config.MODEL.WEIGHTS = str(local_weights)
            config.freeze()
            return default_predictor(config)

        densepose.DefaultPredictor = local_predictor
        from VITON.viton_upperbody import FrameProcessor, make_pix2pix_model
        from SMPL.smpl_regressor import SMPL_Regressor
        from SMPL.upperbody_smpl.UpperBody import UpperBodySMPL
        # Avoid the demo's background loader racing a synchronous garment load.
        processor = FrameProcessor.__new__(FrameProcessor)
        processor.smpl_regressor = SMPL_Regressor(use_bev=True)
        processor.densepose_extractor = densepose.DensePoseExtractor()
        processor.upper_body = UpperBodySMPL()
        processor.lock = threading.Lock()
        processor.viton_model = make_pix2pix_model(
            garment, 6, output_nc=4, ckpt_dir=str(self.root / "checkpoints")
        ).to("cuda:0").eval()
        self.torch, self.np, self.processor = torch, np, processor
        self.metrics = {}
        self._stage(processor.smpl_regressor, "forward", "body_ms")
        self._stage(processor.upper_body, "render", "render_ms")
        self._stage(processor.densepose_extractor, "get_IUV", "densepose_ms")
        self._stage(processor.viton_model, "forward", "generator_ms")

    def _stage(self, target, method, name):
        original = getattr(target, method)

        def measured(*args, **kwargs):
            self.torch.cuda.synchronize()
            start = time.perf_counter()
            result = original(*args, **kwargs)
            self.torch.cuda.synchronize()
            self.metrics[name] = (time.perf_counter() - start) * 1000
            if name == "body_ms":
                self.metrics["body_detected"] = result is not None and result[0] is not None
            elif name == "densepose_ms":
                self.metrics["densepose_detected"] = result is not None
            return result

        setattr(target, method, measured)

    def process(self, bgr):
        """Return BGR output and honest per-frame measurements, no frame saving.

        Synchronization intentionally gives comparable stage timings. This is a
        measured evaluation path, not an optimized overlapping execution path.
        Call only from the thread that owns the EGL context.
        """
        if threading.get_ident() != self.owner_thread:
            raise RuntimeError("RTV evaluation must stay on its owning EGL thread")
        if bgr.ndim != 3 or bgr.shape[2] != 3 or bgr.dtype != self.np.uint8:
            raise ValueError("Expected an unsigned 8-bit, three-channel BGR frame")
        if self.frame_shape is not None and bgr.shape != self.frame_shape:
            raise ValueError("Input size changed; use a new process for the new EGL surface")
        self.frame_shape = bgr.shape
        self.metrics = {"body_detected": False, "densepose_detected": False}
        self.torch.cuda.synchronize()
        start = time.perf_counter()
        with self.torch.inference_mode():
            result = self.processor(bgr)
        self.torch.cuda.synchronize()
        self.metrics["pipeline_ms"] = (time.perf_counter() - start) * 1000
        difference = self.np.max(self.np.abs(result.astype("int16") - bgr.astype("int16")), axis=2)
        self.metrics["changed_pixel_fraction"] = float(self.np.mean(difference > 8))
        self.metrics["generated"] = "generator_ms" in self.metrics
        self.metrics["passthrough"] = not self.metrics["generated"]
        return result, dict(self.metrics)
