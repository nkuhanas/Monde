export function slugifyMondeId(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  return slug.length > 0 ? slug : "monde";
}

export function monIdFromDirectoryName(directoryName: string): string {
  if (!directoryName.endsWith(".mon")) {
    throw new Error(`Mon directory must end in .mon: ${directoryName}`);
  }

  const id = directoryName.slice(0, -".mon".length);
  if (!id) {
    throw new Error("Mon id cannot be empty");
  }

  return id;
}
