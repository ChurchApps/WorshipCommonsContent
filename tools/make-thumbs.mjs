// Back-compat. Prefer: node tools/generate.mjs [folder]
import { run } from "./generate.mjs";
process.exit(run(process.argv.slice(2)));
