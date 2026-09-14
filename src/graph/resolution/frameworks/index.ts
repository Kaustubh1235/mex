import { expressResolver } from "./express.js";
import { flaskResolver } from "./flask.js";
import { nextjsResolver } from "./nextjs.js";
import { nestjsResolver } from "./nestjs.js";
import type { FrameworkResolver } from "../types.js";

/** Reference registry. Community resolvers add one entry here. */
export const FRAMEWORK_RESOLVERS: readonly FrameworkResolver[] = [
  expressResolver,
  flaskResolver,
  nextjsResolver,
  nestjsResolver,
];
export { expressResolver } from "./express.js";
export { flaskResolver } from "./flask.js";
export { nextjsResolver } from "./nextjs.js";
export { nestjsResolver } from "./nestjs.js";
