export const DEPTH_DIAGNOSTIC_LABELS = Object.freeze({
  cached: 'Cached Playback Depth',
  raw: 'Raw Model Depth',
  normalized: 'Normalized Depth',
  stabilized: 'Stabilized Depth',
  final: 'Final Render Depth'
});

function validFrame(frame, width, height) {
  return Boolean(frame && width > 0 && height > 0 && frame.length === width * height);
}

function waitingMessage(stage, depthMode, playbackMode) {
  const label = DEPTH_DIAGNOSTIC_LABELS[stage] || 'Depth diagnostic';
  if (stage === 'cached' && depthMode === 'live' && playbackMode === 'live') {
    return 'Cached playback depth is unavailable in Live only mode. Choose Final Render Depth or switch to Hybrid.';
  }
  if (stage === 'cached') return 'Waiting for a synchronized cached depth frame…';
  if (stage === 'final' && (depthMode !== 'live' || playbackMode === 'hybrid')) {
    return 'Waiting for the synchronized rendered depth frame…';
  }
  return `Waiting for ${label.toLowerCase()} from the depth model…`;
}

export function resolveDepthDiagnosticView({
  stage = 'off',
  depthMode = 'cached',
  playbackMode = 'hybrid',
  liveDiagnostics = null,
  playbackDiagnostic = null
} = {}) {
  const label = DEPTH_DIAGNOSTIC_LABELS[stage] || 'Depth Diagnostic';
  if (stage === 'off' || !(stage in DEPTH_DIAGNOSTIC_LABELS)) {
    return { visible: false, ready: false, stage, label };
  }

  const finalUsesPlayback = stage === 'final' && (depthMode !== 'live' || playbackMode === 'hybrid');
  if (stage === 'cached' || finalUsesPlayback) {
    const width = Number(playbackDiagnostic?.width) || 0;
    const height = Number(playbackDiagnostic?.height) || 0;
    if (validFrame(playbackDiagnostic?.frame, width, height)) {
      return {
        visible: true,
        ready: true,
        stage,
        label,
        kind: 'playback',
        frame: playbackDiagnostic.frame,
        width,
        height,
        snapshot: playbackDiagnostic
      };
    }
    return {
      visible: true,
      ready: false,
      stage,
      label,
      kind: 'playback',
      message: waitingMessage(stage, depthMode, playbackMode)
    };
  }

  if (depthMode !== 'live') {
    return {
      visible: true,
      ready: false,
      stage,
      label,
      kind: 'live',
      message: `${label} is available for an imported video. The bundled demo provides authored cached depth; choose Final Render Depth to inspect it.`
    };
  }

  const width = Number(liveDiagnostics?.width) || 0;
  const height = Number(liveDiagnostics?.height) || 0;
  if (validFrame(liveDiagnostics?.[stage], width, height)) {
    return {
      visible: true,
      ready: true,
      stage,
      label,
      kind: 'live',
      frame: liveDiagnostics[stage],
      width,
      height,
      snapshot: liveDiagnostics
    };
  }

  return {
    visible: true,
    ready: false,
    stage,
    label,
    kind: 'live',
    message: waitingMessage(stage, depthMode, playbackMode)
  };
}
