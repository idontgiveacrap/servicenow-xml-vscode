# Dictionary export fixtures

Studio Git exports write a table's schema under `<app_sys_id>/dictionary/` using a
`<database>` root instead of `record_update` / `unload`. These files carry no
`action=` rows and no `sys_id`: the table name and its label are attributes on the
root's `type="collection"` element, and each column is a nested `<element>`.

- `x_example_0_compare_row.xml` — anonymized collection with string, boolean,
  reference and choice columns plus an `<index>`

The navigator indexes one record per file from the collection element (table from
`name`, display name from `label`). The basename is conventionally the table name
but is not trusted for it, since these files can be renamed and stay valid.
