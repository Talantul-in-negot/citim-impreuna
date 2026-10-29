/* Aceeași paginare în browser și în cheia de răspunsuri a serverului. */
function buildChapterPages(verses, pageSize = 5) {
  const pages = [];
  let previousChapter = null;
  for (const verse of verses) {
    const chapter = verse.ref.replace(/:\d+$/, "");
    if (!pages.length || chapter !== previousChapter || pages[pages.length - 1].length >= pageSize) {
      pages.push([]);
    }
    pages[pages.length - 1].push(verse);
    previousChapter = chapter;
  }
  return pages;
}

if (typeof module !== "undefined" && module.exports) module.exports = { buildChapterPages };
