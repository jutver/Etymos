// Motion's animation engine, loaded on its own after the first paint (see
// LazyMotion in main.tsx). Components use `m.*` instead of `motion.*` so the
// engine stays out of the first download. domAnimation covers what the site
// uses: animate/exit, variants, hover/tap. Switch to domMax if a component
// ever needs layout animations or drag.
export { domAnimation as default } from "motion/react";
