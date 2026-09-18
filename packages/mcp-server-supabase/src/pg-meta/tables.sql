SELECT
  c.oid :: int8 AS id,
  nc.nspname AS schema,
  c.relname AS name,
  c.relrowsecurity AS rls_enabled,
  c.relforcerowsecurity AS rls_forced,
  CASE
    WHEN c.relreplident = 'd' THEN 'DEFAULT'
    WHEN c.relreplident = 'i' THEN 'INDEX'
    WHEN c.relreplident = 'f' THEN 'FULL'
    ELSE 'NOTHING'
  END AS replica_identity,
  pg_total_relation_size(format('%I.%I', nc.nspname, c.relname)) :: int8 AS bytes,
  pg_size_pretty(
    pg_total_relation_size(format('%I.%I', nc.nspname, c.relname))
  ) AS size,
  pg_stat_get_live_tuples(c.oid) AS live_rows_estimate,
  pg_stat_get_dead_tuples(c.oid) AS dead_rows_estimate,
  obj_description(c.oid) AS comment,
  coalesce(pk.primary_keys, '[]') as primary_keys,
  coalesce(
    jsonb_agg(relationships) filter (where relationships is not null),
    '[]'
  ) as relationships
FROM
  pg_namespace nc
  JOIN pg_class c ON nc.oid = c.relnamespace
  left join (
    -- Walk indkey positionally: `= any (indkey)` discards the position of each
    -- column within the key, so rows come back in attnum order rather than
    -- constraint-definition order. indkey also holds the index's INCLUDE payload
    -- columns, which are not part of the key -- indnkeyatts bounds it to the real
    -- key columns. Same ordering guarantee the foreign key subquery below relies on.
    select
      table_id,
      jsonb_agg(to_jsonb(_pk) - 'ord' order by _pk.ord) as primary_keys
    from (
      select
        n.nspname as schema,
        c.relname as table_name,
        a.attname as name,
        c.oid :: int8 as table_id,
        k.ord
      from
        pg_index i
        join pg_class c on i.indrelid = c.oid
        join pg_namespace n on c.relnamespace = n.oid
        cross join lateral unnest(i.indkey :: int2[]) with ordinality as k(attnum, ord)
        join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
      where
        i.indisprimary
        and k.ord <= i.indnkeyatts
    ) as _pk
    group by table_id
  ) as pk
  on pk.table_id = c.oid
  left join (
    select
      c.oid :: int8 as id,
      c.conname as constraint_name,
      nsa.nspname as source_schema,
      csa.relname as source_table_name,
      array_agg(sa.attname order by cols.ord) as source_columns,
      nta.nspname as target_table_schema,
      cta.relname as target_table_name,
      array_agg(ta.attname order by cols.ord) as target_columns
    from
      pg_constraint c
      join lateral unnest(c.conkey, c.confkey)
        with ordinality as cols(conkey, confkey, ord) on true
      join pg_class csa on csa.oid = c.conrelid
      join pg_namespace nsa on nsa.oid = csa.relnamespace
      join pg_attribute sa
        on sa.attrelid = c.conrelid and sa.attnum = cols.conkey
      join pg_class cta on cta.oid = c.confrelid
      join pg_namespace nta on nta.oid = cta.relnamespace
      join pg_attribute ta
        on ta.attrelid = c.confrelid and ta.attnum = cols.confkey
    where
      c.contype = 'f'
    group by
      c.oid, c.conname, nsa.nspname, csa.relname, nta.nspname, cta.relname
  ) as relationships
  on (relationships.source_schema = nc.nspname and relationships.source_table_name = c.relname)
  or (relationships.target_table_schema = nc.nspname and relationships.target_table_name = c.relname)
WHERE
  c.relkind IN ('r', 'p')
  AND NOT pg_is_other_temp_schema(nc.oid)
  AND (
    pg_has_role(c.relowner, 'USAGE')
    OR has_table_privilege(
      c.oid,
      'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
    )
    OR has_any_column_privilege(c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
  )
group by
  c.oid,
  c.relname,
  c.relrowsecurity,
  c.relforcerowsecurity,
  c.relreplident,
  nc.nspname,
  pk.primary_keys