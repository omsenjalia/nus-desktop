# Third-party notices

J.A.R.V.I.S bundles or downloads third-party work. The licences below require
attribution, and `companion/test/parakeet.test.js` checks that this file keeps
naming both models by name and licence. If you swap a model, change it here in
the same commit.

## Models

### nvidia/parakeet-tdt-0.6b-v3

- **Used for:** speech to text, the engine behind dictation when the speech
  model is set to Parakeet.
- **Licence:** CC-BY-4.0 (Creative Commons Attribution 4.0 International).
- **Source:** <https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3>
- **Distribution:** the sherpa-onnx int8 packaging,
  `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2` (487,211,443 bytes),
  downloaded from the sherpa-onnx `asr-models` release, pinned by SHA-256 in
  `companion/src/voice/parakeet.js`.
- **Attribution:** the model is the work of NVIDIA and the NVIDIA NeMo team.
  No modification is made to the weights. The CC-BY-4.0 licence text is at
  <https://creativecommons.org/licenses/by/4.0/legalcode>.

### hexgrad/Kokoro-82M v1.0 ("Fable")

- **Used for:** speech synthesis, the voice J.A.R.V.I.S speaks in (speaker 25,
  `bm_fable`, a British voice).
- **Licence:** Apache-2.0.
- **Source:** <https://huggingface.co/hexgrad/Kokoro-82M>
- **Distribution:** the sherpa-onnx packaging,
  `kokoro-multi-lang-v1_0.tar.bz2`, downloaded from the sherpa-onnx `tts-models`
  release and pinned by SHA-256 in `companion/src/voice/index.js`.

## Engines

### sherpa-onnx

- **Used for:** running both models locally, as a native Node addon
  (`sherpa-onnx-node`).
- **Licence:** Apache-2.0.
- **Source:** <https://github.com/k2-fsa/sherpa-onnx>
- The addon and the two worker scripts are unpacked from the asar on purpose
  (`asarUnpack` in `electron-builder.config.js`): the workers run under
  `ELECTRON_RUN_AS_NODE`, which has no asar support, and a native `.node` addon
  cannot be loaded from inside an archive.

### whisper.cpp

- **Used for:** speech to text, the fallback when Parakeet is not installed.
- **Licence:** MIT.
- **Source:** <https://github.com/ggml-org/whisper.cpp>
- Windows binaries only, fetched by `npm run setup:voice` and packaged under
  `resources/whisper` (`extraResources` in `electron-builder.config.js`).

## Upstream

J.A.R.V.I.S descends from Nūs Desktop by Pranav Desu, MIT licensed. That
copyright is kept in `LICENSE` and in the `copyright` field of
`electron-builder.config.js`.
