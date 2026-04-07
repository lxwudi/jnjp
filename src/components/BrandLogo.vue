<template>
  <svg viewBox="0 0 80 80" class="brand-logo" aria-hidden="true">
    <defs>
      <linearGradient id="brand-shell-fill" x1="12" y1="8" x2="68" y2="72" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#162027" />
        <stop offset="100%" stop-color="#0d1419" />
      </linearGradient>
      <linearGradient id="brand-shell-stroke" x1="16" y1="10" x2="63" y2="69" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#5fe2ff" />
        <stop offset="100%" stop-color="#c9ff4d" />
      </linearGradient>
      <linearGradient id="brand-core-fill" x1="26" y1="24" x2="58" y2="58" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#70e7ff" />
        <stop offset="100%" stop-color="#d8ff6a" />
      </linearGradient>
      <filter id="brand-glow" x="-30%" y="-30%" width="160%" height="160%">
        <feDropShadow dx="0" dy="0" stdDeviation="3.6" flood-color="#90f0ff" flood-opacity="0.28" />
      </filter>
    </defs>

    <path
      class="brand-shell"
      d="M12 8 H54 L68 22 V72 H12 Z"
      fill="url(#brand-shell-fill)"
      stroke="url(#brand-shell-stroke)"
      stroke-width="1.6"
      filter="url(#brand-glow)"
    />
    <path
      class="brand-shell-inner"
      d="M17 13 H51 L63 25 V67 H17 Z"
      fill="none"
      stroke="rgba(255,255,255,0.11)"
      stroke-width="1"
    />

    <g class="brand-ports">
      <rect x="20" y="18" width="9" height="4.5" rx="1.4" />
      <rect x="31.5" y="18" width="9" height="4.5" rx="1.4" />
      <rect x="43" y="18" width="9" height="4.5" rx="1.4" />
      <rect x="54.5" y="18" width="4.5" height="4.5" rx="1.2" />
    </g>

    <g class="brand-traces">
      <path d="M27 30 H34" />
      <path d="M46 30 H53" />
      <path d="M25 53 H33" />
      <path d="M47 53 H55" />
    </g>

    <g class="brand-nodes">
      <circle cx="24" cy="30" r="2.2" />
      <circle cx="56" cy="30" r="2.2" />
      <circle cx="22" cy="53" r="2.2" />
      <circle cx="58" cy="53" r="2.2" />
    </g>

    <path
      class="brand-core"
      d="M39.8 24.5 C31.5 28 27.2 36.1 29.1 44.2 C31.2 53.1 40.9 58.8 49.7 56.6 C56.7 54.9 61.8 47.9 60.9 40.6 C60 32.6 53.9 26.3 45.6 24.7 L42.9 34.4 L49.7 34.4 L39.1 50.6 L41.7 40.8 L35.1 40.8 Z"
      fill="url(#brand-core-fill)"
    />
    <path
      class="brand-vein"
      d="M44 27.8 C48.8 33 49.6 41.4 46.3 48.2 C44.9 51.1 42.8 53.4 39.8 55"
    />
  </svg>
</template>

<style scoped>
.brand-logo {
  display: block;
}

.brand-shell,
.brand-shell-inner {
  vector-effect: non-scaling-stroke;
}

.brand-ports rect {
  fill: rgba(222, 240, 248, 0.82);
}

.brand-traces path {
  stroke: rgba(126, 184, 214, 0.55);
  stroke-width: 1.5;
  stroke-linecap: round;
}

.brand-nodes circle {
  fill: #0e161b;
  stroke: #8ee9ff;
  stroke-width: 1.5;
}

.brand-core {
  filter: drop-shadow(0 0 8px rgba(201, 255, 77, 0.2));
}

.brand-vein {
  fill: none;
  stroke: rgba(12, 20, 26, 0.86);
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
