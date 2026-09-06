import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: false });

/**
 * Minimal sanitiser. Content originates from our own Claude calls and EDGAR
 * text, but the brief is user-supplied and flows into prompts, so strip the
 * obvious script vectors before dangerouslySetInnerHTML.
 */
export function renderMarkdown(src: string): string {
  const html = marked.parse(src ?? "", { async: false }) as string;
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/\son\w+="[^"]*"/gi, "")
    .replace(/\son\w+='[^']*'/gi, "")
    .replace(/javascript:/gi, "");
}
