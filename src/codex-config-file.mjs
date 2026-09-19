import { getStaticTOMLValue, parseTOML } from "toml-eslint-parser";

export function parseCodexConfig(text) {
  return parseTOML(text, { tomlVersion: "1.0.0" });
}

export function readCodexConfig(text) {
  return getStaticTOMLValue(parseCodexConfig(text));
}

function keyParts(node) {
  return node.key.keys.map((key) => key.type === "TOMLBare" ? key.name : key.value);
}

export function patchRootConfig(text, values) {
  const body = parseCodexConfig(text).body[0].body;
  const edits = [];
  const additions = [];
  for (const [key, value] of Object.entries(values)) {
    const node = body.find((item) => item.type === "TOMLKeyValue" && keyParts(item).length === 1 && keyParts(item)[0] === key);
    if (node) {
      edits.push({ start: value === undefined ? node.range[0] : node.value.range[0], end: node.range[1], text: value === undefined ? "" : JSON.stringify(value) });
    } else if (value !== undefined) additions.push(`${key} = ${JSON.stringify(value)}\n`);
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  }
  const result = additions.join("") + text;
  parseCodexConfig(result);
  return result;
}

export function patchProviderConfig(text, providerId, providerContents) {
  const ast = parseCodexConfig(text);
  const edits = [];
  for (const node of ast.body[0].body) {
    if (node.type !== "TOMLTable") continue;
    const parts = node.resolvedKey || keyParts(node);
    if (parts[0] === "model_providers" && parts[1] === providerId) {
      edits.push({ start: node.range[0], end: node.range[1] });
    }
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, edit.start) + text.slice(edit.end);
  }
  // Remove only real marker comments, never matching text inside instructions.
  const markers = parseCodexConfig(text).comments.filter((comment) =>
    ["# >>> CABLETIDY MANAGED PROVIDER", "# <<< CABLETIDY MANAGED PROVIDER"].some((marker) =>
      text.slice(...comment.range).startsWith(`${marker} ${providerId} `),
    ),
  );
  for (const comment of markers.sort((a, b) => b.range[0] - a.range[0])) {
    text = text.slice(0, comment.range[0]) + text.slice(comment.range[1]);
  }
  const updatedAst = parseCodexConfig(text);
  const firstProvider = updatedAst.body[0].body.find((node) => {
    if (node.type !== "TOMLTable") return false;
    const parts = node.resolvedKey || keyParts(node);
    return parts[0] === "model_providers";
  });
  const providerBlock = `${providerContents.trimEnd()}\n\n`;
  const result = firstProvider
    ? `${text.slice(0, firstProvider.range[0]).trimEnd()}\n\n${providerBlock}${text.slice(firstProvider.range[0])}`
    : `${text.trimEnd()}\n\n${providerContents}`;
  parseCodexConfig(result);
  return result;
}
