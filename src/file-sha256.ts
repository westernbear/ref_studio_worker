import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export const fileSha256 = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};
