# ONNX mask-worker cold start

The 2026-10-15 opening-video batch spent several minutes before producing its first frame. The child remained CPU-active, no frame checkpoints existed, and `rembg.bg` eagerly imported PyMatting even though this worker requested only a mask and never alpha matting. A separate import with `NUMBA_DISABLE_JIT=1` completed in 2.791 seconds.

The change sets that default immediately before importing rembg in the ONNX mask branch. It does not affect plain-background masks or overwrite a caller's explicit Numba setting. Model selection, ONNX inference, postprocessing options, and mask composition remain unchanged.

A bounded probe exercised the real worker with the same first 960×720 source frame, a fresh Numba cache, and no inherited `NUMBA_DISABLE_JIT` setting. Before the change it exceeded 12.017 seconds and was stopped; after the change it produced a mask in 1.792 seconds. Its SHA-256 was `13346653b7d83fd3e06c468bc6bf49adf9950a4525f8c6536bf44a65fbe51f8c`. This measures cold first-mask latency, not an entire-video speed ratio. The interrupted production attempt was retained and cancelled explicitly; a new whole-video matting attempt completed all 145 frames.

Probe source and before/after JSON evidence are retained in `production/character-20261015/opening-7/` under the parent workspace. `bun run typecheck` completed successfully after the worker change. The production candidate receives its own full technical check and bounded final-PNG visual sampling; this performance check is not visual acceptance.
