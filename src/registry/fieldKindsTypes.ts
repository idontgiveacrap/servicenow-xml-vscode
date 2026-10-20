/** Shape of src/data/fieldKinds.json (packed from dictionary). */
export interface FieldKindsPack {
  version: number;
  scriptPairs: string[];
  clientScriptPairs: string[];
  cssFieldNames: string[];
  jsonFieldNames: string[];
  /** `table.element` pairs whose dictionary type is HTML. */
  htmlPairs?: string[];
  /** `table.element` pairs whose dictionary type is XML, including Jelly bodies. */
  xmlPairs?: string[];
}
