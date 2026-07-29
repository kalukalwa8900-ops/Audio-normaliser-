// Kept as a compatibility shim. The canonical pipeline is already concurrent,
// strictly two-pass, and verification-gated.
export { runJob } from "./pipeline.js";
