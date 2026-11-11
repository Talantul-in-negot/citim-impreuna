/* Categoriile și ordinea fixă de lectură, comune browserului și verificărilor. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ReadingPath = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const categories = [
    { id: "preschool_1", label: "Preșcolari – clasa I", epistle: "iuda" },
    { id: "grades_2_3", label: "Clasele II–III", epistle: "iuda" },
    { id: "grades_4_5", label: "Clasele IV–V", epistle: "1petru" },
    { id: "grades_6_7", label: "Clasele VI–VII", epistle: "filipeni" },
    { id: "grades_8_9", label: "Clasele VIII–IX", epistle: "galateni" },
    { id: "grades_10_11", label: "Clasele X–XI", epistle: "evrei" },
    { id: "adults_18_35", label: "18–35 de ani", epistle: "evrei" },
    { id: "adults_35_plus", label: "35+ de ani", epistle: "evrei" },
  ];
  function getCategory(id) {
    return categories.find(category => category.id === id) || null;
  }
  function buildVerses(id, samuel, epistles) {
    const category = getCategory(id);
    if (!category || !Array.isArray(epistles[category.epistle]) || !epistles[category.epistle].length) {
      throw new Error("Textul categoriei nu este disponibil. Reîncarcă aplicația când ai conexiune la internet.");
    }
    return [...samuel, ...epistles[category.epistle]];
  }
  function isSamuelRef(ref) { return /^[12] Samuel \d+:\d+$/.test(ref || ""); }
  function bookName(ref) { return String(ref || "").replace(/ \d+:\d+$/, ""); }
  return { categories, getCategory, buildVerses, isSamuelRef, bookName };
});
