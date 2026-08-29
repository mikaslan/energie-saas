ALTER TABLE "project_requirement" DROP CONSTRAINT "project_requirement_json_ck";--> statement-breakpoint
ALTER TABLE "project_requirement" ADD CONSTRAINT "project_requirement_json_ck" CHECK ((
        jsonb_typeof("project_requirement"."requirements") = 'object'
        and ("project_requirement"."requirements" - array[
          'schemaVersion', 'source', 'branch', 'requestedProducts'
        ]::text[]) = '{}'::jsonb
        and "project_requirement"."requirements"->>'schemaVersion' = "project_requirement"."schema_version"
        and "project_requirement"."requirements"->>'source' = 'wmee-rechner-v3'
        and "project_requirement"."requirements"->>'branch' in ('new_installation', 'existing_installation')
        and jsonb_typeof("project_requirement"."requirements"->'requestedProducts') = 'object'
        and (("project_requirement"."requirements"->'requestedProducts') - array[
          'targetStorageKwh', 'wallbox', 'bidirectionalCharging', 'backupPower'
        ]::text[]) = '{}'::jsonb
        and jsonb_typeof("project_requirement"."requirements"#>'{requestedProducts,targetStorageKwh}') = 'number'
        and jsonb_typeof("project_requirement"."requirements"#>'{requestedProducts,wallbox}') = 'boolean'
        and jsonb_typeof("project_requirement"."requirements"#>'{requestedProducts,bidirectionalCharging}') = 'boolean'
        and jsonb_typeof("project_requirement"."requirements"#>'{requestedProducts,backupPower}') = 'boolean'
      ) is true);