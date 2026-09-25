UPDATE entities
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
WHERE kind = 'constraint' AND payload->>'type' IN ('no-overlap', 'affinity-boost') AND NOT payload ? 'groups';
