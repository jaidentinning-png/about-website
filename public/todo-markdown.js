(function (root) {
  function cleanText(value) {
    return value
      .replace(/&#x20;|&#32;|&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*(.*?)\*\*|__(.*?)__/g, "$1$2")
      .replace(/~~(.*?)~~/g, "$1")
      .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1$2")
      .replace(/(^|[^_])_([^_]+)_(?!_)/g, "$1$2")
      .trim();
  }

  function parseTodoMarkdown(markdown) {
    const groups = [];
    const bySection = new Map();
    let activeSection = "General";

    for (const rawLine of String(markdown || "").split(/\r?\n/)) {
      const line = rawLine.trim();
      const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        if (heading[1].length > 1) {
          activeSection = cleanText(heading[2]) || "General";
        }
        continue;
      }

      const bullet = line.match(/^(?:[-*+]\s+|\d+[.)]\s+)(?:\[[ xX]\]\s*)?(.+?)\s*$/);
      if (!bullet) continue;

      const title = cleanText(bullet[1]);
      if (!title) continue;
      let group = bySection.get(activeSection);
      if (!group) {
        group = { section: activeSection, items: [] };
        bySection.set(activeSection, group);
        groups.push(group);
      }
      group.items.push(title);
    }

    return groups;
  }

  root.parseTodoMarkdown = parseTodoMarkdown;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { parseTodoMarkdown };
  }
})(globalThis);
