export function percentValue(value) {
  return Number.isFinite(value) ? `${Math.round(Math.max(0, Math.min(100, value)))}%` : 'N/A';
}

export function meterWidth(value) {
  return Number.isFinite(value) ? `${Math.max(0, Math.min(100, value))}%` : '0%';
}

export function executionModeLabel(acceleration) {
  if (acceleration?.verified !== true) return 'Automatic · not yet observed';
  return (
    { cpu: 'CPU · verified', gpu: 'GPU · verified', mixed: 'CPU + GPU · verified' }[
      acceleration.mode
    ] || 'Automatic · not yet observed'
  );
}
