const base = "http://127.0.0.1:43187";
const smoke = await Bun.file("docs/evidence/p0/upstream-smoke.json").json();
const timeline = await (await fetch(`${base}/api/projects/${smoke.projectId}/timeline`)).json() as any;
const placed = await fetch(`${base}/api/tracks/${timeline.tracks[0].id}/place-frames`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ frameIds: timeline.poolFrames.map((f: any) => f.id) }),
});
if (!placed.ok) throw new Error(await placed.text());
console.log(await placed.json());
