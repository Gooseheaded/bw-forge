import { rm } from "node:fs/promises";

const targets = ["dist", ".pack-smoke"];

await Promise.all(
  targets.map((target) =>
    rm(target, {
      recursive: true,
      force: true
    })
  )
);
