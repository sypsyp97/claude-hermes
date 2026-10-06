/** Names used as filesystem components must not supply a path or Windows drive. */
export function isSkillPathSegment(name: string): boolean {
  return typeof name === "string" && name.length > 0 && name !== "." && name !== ".." && !/[\\/:\0]/.test(name);
}

export function assertSkillPathSegment(name: string): void {
  if (!isSkillPathSegment(name)) throw new Error(`invalid skill name: ${JSON.stringify(name)}`);
}
