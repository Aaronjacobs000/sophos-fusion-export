#!/usr/bin/env node
// Writes docs/data-dictionary.md from the schema. Run after `npm run build`.
import { writeFileSync } from "node:fs";
import { dataDictionary } from "../dist/schema/dictionary.js";

writeFileSync(new URL("../docs/data-dictionary.md", import.meta.url), `${dataDictionary()}\n`);
console.log("wrote docs/data-dictionary.md");
