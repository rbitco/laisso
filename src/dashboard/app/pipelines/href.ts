/** The page's link to a Pipeline's editor, or to one of its frozen Versions. */
export function pipelineHref(name: string, version?: number): string {
  return "#pipelines/" + encodeURIComponent(name) + (version === undefined ? "" : "/v" + version);
}
