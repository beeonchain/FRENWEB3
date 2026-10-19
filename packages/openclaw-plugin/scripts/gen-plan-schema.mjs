// Regenerates src/plan-schema.json from the Plan schema in @jarvis/core, so the
// plugin can describe the tool input without depending on core at runtime.
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { Plan } from "@jarvis/core";

const schema = z.toJSONSchema(Plan, { io: "input", target: "draft-7" });
delete schema.$schema;
writeFileSync(new URL("../src/plan-schema.json", import.meta.url), `${JSON.stringify(schema, null, 2)}\n`);
console.log("wrote src/plan-schema.json");
