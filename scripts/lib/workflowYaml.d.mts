/** 検査に使ってよい workflow ならトップレベルの mapping を、使えなければ理由 (`document: …`) の一覧を返す。 */
export function readWorkflowYaml(source: string): { data: Record<string, unknown> } | { problems: string[] };
export function isMapping(value: unknown): value is Record<string, unknown>;
