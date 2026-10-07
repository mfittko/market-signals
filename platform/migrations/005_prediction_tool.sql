-- Existing agents get the advisory prediction tool. New and seeded agents carry it in their defaults.
UPDATE agents SET allowed_tools = array_append(allowed_tools, 'get_prediction')
WHERE NOT ('get_prediction' = ANY(allowed_tools));
