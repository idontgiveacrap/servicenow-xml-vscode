/**
 * Retired — script/CSS field sets come from the dictionary pack.
 *
 * Use:
 *   node scripts/pack-dictionary.js "path/to/sys_dictionary.csv"
 *
 * That writes src/data/dictionaryFields.json.gz and runs pack-field-kinds.js
 * to produce src/data/fieldKinds.json (consumed by parseSnXml / scriptProfile).
 */

console.error(
  'pack-script-fields.js is retired. Run: node scripts/pack-dictionary.js <sys_dictionary.csv>'
);
process.exit(1);
