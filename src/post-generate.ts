export const postGenerate = async (
  baseUrl: string,
  request: Readonly<{ prompt: string; seed: number }>,
  signal: AbortSignal,
  failedToken: string,
): Promise<Uint8Array> => {
  const response = await fetch(`${baseUrl.replace(/\/+$/u, "")}/v1/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: request.prompt, seed: request.seed }),
    signal,
  });
  if (!response.ok) throw new Error(`${failedToken}:${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
};
