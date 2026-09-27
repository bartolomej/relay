/**
 * Brings the children of `from` in line with those of `to`, reusing every node
 * that can stay. Scroll boxes, focus and running animations survive, so a chat
 * that is streaming scrolls the same as an idle one.
 */
export function morphChildren(from: Node, to: Node): void {
  let cur = from.firstChild;
  for (const next of Array.from(to.childNodes)) {
    if (!cur) {
      from.appendChild(next);
      continue;
    }
    const after = cur.nextSibling;
    morphNode(cur, next);
    cur = after;
  }
  while (cur) {
    const after: ChildNode | null = cur.nextSibling;
    from.removeChild(cur);
    cur = after;
  }
}

function morphNode(from: ChildNode, to: ChildNode): void {
  // nodeName tells text, comments and each tag apart.
  if (from.nodeName !== to.nodeName) {
    from.replaceWith(to);
    return;
  }
  if (!(from instanceof Element)) {
    if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
    return;
  }
  if (from.isEqualNode(to)) return;
  syncAttributes(from, to as Element);
  morphChildren(from, to);
}

function syncAttributes(from: Element, to: Element): void {
  for (const { name } of Array.from(from.attributes)) {
    if (!to.hasAttribute(name)) from.removeAttribute(name);
  }
  for (const { name, value } of Array.from(to.attributes)) {
    if (from.getAttribute(name) !== value) from.setAttribute(name, value);
  }
}
