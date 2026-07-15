// Premium Framer Motion animation configuration presets for Chanakya AI
export const presets = {
  // Elastic spring for chat expanding or bubbles popping in
  springElastic: {
    type: "spring",
    stiffness: 300,
    damping: 18,
    mass: 0.8,
  },
  // Smooth spring for standard transitions, panel toggles, and layouts
  springSmooth: {
    type: "spring",
    stiffness: 220,
    damping: 26,
    mass: 1.0,
  },
  // Premium quick bounce for button micro-animations
  appleBounce: {
    type: "spring",
    stiffness: 450,
    damping: 15,
    mass: 0.5,
  },
  // Glide transition (e.g. settings sliding in)
  glide: {
    type: "spring",
    stiffness: 180,
    damping: 22,
  },
  // Tween ease for soft/linear fades
  fade: {
    type: "tween",
    ease: [0.25, 0.1, 0.25, 1],
    duration: 0.25,
  },
  // Soft pulse for background glows and active states
  pulse: {
    scale: [1, 1.05, 1],
    opacity: [0.8, 1, 0.8],
    transition: {
      duration: 2.5,
      repeat: Infinity,
      ease: "easeInOut",
    }
  }
};
