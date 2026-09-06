import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  playbookSchema,
  validatePlaybookGraph,
  type Playbook,
} from "./schema";

const PLAYBOOK_DIR = join(process.cwd(), "playbooks");

let cache: Map<string, Playbook> | null = null;

export async function loadPlaybooks(): Promise<Map<string, Playbook>> {
  if (cache) return cache;
  const files = (await readdir(PLAYBOOK_DIR)).filter((f) => /\.ya?ml$/.test(f));
  const map = new Map<string, Playbook>();
  for (const file of files) {
    const raw = await readFile(join(PLAYBOOK_DIR, file), "utf8");
    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch (e) {
      throw new Error(`Playbook ${file}: invalid YAML — ${(e as Error).message}`);
    }
    const pb = playbookSchema.parse(parsed);
    validatePlaybookGraph(pb);
    if (map.has(pb.id)) throw new Error(`Duplicate playbook id "${pb.id}" (${file})`);
    map.set(pb.id, pb);
  }
  if (map.size === 0) throw new Error(`No playbooks found in ${PLAYBOOK_DIR}`);
  cache = map;
  return map;
}

export async function getPlaybook(idOrAlias: string): Promise<Playbook> {
  const map = await loadPlaybooks();
  const key = idOrAlias.trim().toLowerCase();
  const direct = map.get(key);
  if (direct) return direct;
  for (const pb of map.values()) {
    if (pb.aliases.map((a) => a.toLowerCase()).includes(key)) return pb;
  }
  throw new Error(
    `Unknown proposal type "${idOrAlias}". Known: ${[...map.keys()].join(", ")}`,
  );
}

export async function listPlaybooks(): Promise<
  { id: string; name: string; description: string; aliases: string[]; inputs: Playbook["inputs"] }[]
> {
  const map = await loadPlaybooks();
  return [...map.values()].map((pb) => ({
    id: pb.id,
    name: pb.name,
    description: pb.description,
    aliases: pb.aliases,
    inputs: pb.inputs,
  }));
}

/** test seam */
export function __resetPlaybookCache(): void {
  cache = null;
}
