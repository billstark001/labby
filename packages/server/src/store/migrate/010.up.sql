UPDATE constraints
SET payload = (payload - 'personIds' - 'tagIds' - 'otherPersonIds' - 'otherTagIds' - 'additionalGroups')
  || jsonb_build_object('groups',
    jsonb_build_array(jsonb_build_object(
      'personIds', coalesce(payload->'personIds', '[]'::jsonb),
      'tagIds', coalesce(payload->'tagIds', '[]'::jsonb)
    ))
    || CASE WHEN jsonb_array_length(coalesce(payload->'otherPersonIds', '[]'::jsonb)) > 0
             OR jsonb_array_length(coalesce(payload->'otherTagIds', '[]'::jsonb)) > 0
       THEN jsonb_build_array(jsonb_build_object(
         'personIds', coalesce(payload->'otherPersonIds', '[]'::jsonb),
         'tagIds', coalesce(payload->'otherTagIds', '[]'::jsonb)
       )) ELSE '[]'::jsonb END
    || coalesce(payload->'additionalGroups', '[]'::jsonb)
  )
WHERE type IN ('no-overlap', 'affinity-boost') AND NOT payload ? 'groups';

UPDATE constraints AS c
SET person_ids = (SELECT coalesce(jsonb_agg(DISTINCT member.value), '[]'::jsonb)
  FROM jsonb_array_elements(c.payload->'groups') AS grp(value)
  CROSS JOIN LATERAL jsonb_array_elements(grp.value->'personIds') AS member(value)),
  tag_ids = (SELECT coalesce(jsonb_agg(DISTINCT member.value), '[]'::jsonb)
  FROM jsonb_array_elements(c.payload->'groups') AS grp(value)
  CROSS JOIN LATERAL jsonb_array_elements(grp.value->'tagIds') AS member(value))
WHERE type IN ('no-overlap', 'affinity-boost');
