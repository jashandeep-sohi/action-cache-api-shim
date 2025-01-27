// See: https://rollupjs.org/introduction/

import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import json from "@rollup/plugin-json";

const config = {
  input: {
    pre: "pre/index.ts",
    main: "src/index.ts"
  },
  output: {
    esModule: true,
    dir: "dist",
    format: "es",
    sourcemap: true
  },
  plugins: [typescript(), nodeResolve(), commonjs(), json()]
};

export default config;
