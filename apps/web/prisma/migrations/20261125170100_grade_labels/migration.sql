-- Numeric grades read "Grade 7" (the admin dropdown showed a bare "7" beside
-- "Grade 6") and sort by number (6, 7, 8, 9, 10). Codes are unchanged.
UPDATE "Grade" SET "label" = 'Grade ' || "name" WHERE "name" ~ '^[0-9]+$' AND btrim("label") = "name";
UPDATE "Grade" SET "sortOrder" = CAST("name" AS INTEGER) * 10 WHERE "name" ~ '^[0-9]+$' AND length("name") <= 6;
