ALTER TABLE "project_calculation_job" DROP CONSTRAINT "project_calculation_job_preparation_ck";--> statement-breakpoint
ALTER TABLE "project_calculation_job" DROP CONSTRAINT "project_calculation_job_versions_ck";--> statement-breakpoint
ALTER TABLE "project_calculation_revision" DROP CONSTRAINT "project_calculation_revision_versions_ck";--> statement-breakpoint
ALTER TABLE "project_calculation_job" ADD CONSTRAINT "project_calculation_job_preparation_ck" CHECK ((
        ("project_calculation_job"."preparation_snapshot" is null and "project_calculation_job"."preparation_sha256" is null)
        or (
          jsonb_typeof("project_calculation_job"."preparation_snapshot") = 'object'
          and "project_calculation_job"."preparation_snapshot"->>'schemaVersion'
            in ('project-calculation-preparation.v1', 'project-calculation-preparation.v2')
          and octet_length("project_calculation_job"."preparation_sha256") = 32
        )
      ) is true);--> statement-breakpoint
ALTER TABLE "project_calculation_job" ADD CONSTRAINT "project_calculation_job_versions_ck" CHECK ((
        ("project_calculation_job"."contract_version" = 'planning-calculation.v1'
          and length(btrim("project_calculation_job"."provider_recipe_version")) between 1 and 100
          and "project_calculation_job"."model_id" = 'wmee-solar'
          and "project_calculation_job"."model_version" ~ '^[0-9]+\.[0-9]+\.[0-9]+([+-][a-z0-9.-]+)?$'
          and "project_calculation_job"."source_revision" ~ '^[0-9a-f]{40}$'
          and "project_calculation_job"."defaults_version" = 'wmee-planning-defaults.v1')
        or ("project_calculation_job"."contract_version" = 'planning-calculation.v2'
          and "project_calculation_job"."provider_recipe_version" = 'pvgis-5.3-sarah3-2020-quarter-hour.v2'
          and "project_calculation_job"."model_id" = 'wmee-solar'
          and "project_calculation_job"."model_version" = '2.0.0'
          and "project_calculation_job"."source_revision" = '6637feab232b265020fc4b257574df76a0b071bd'
          and "project_calculation_job"."defaults_version" = 'wmee-planning-defaults.v2')
      ));--> statement-breakpoint
ALTER TABLE "project_calculation_revision" ADD CONSTRAINT "project_calculation_revision_versions_ck" CHECK ((
        ("project_calculation_revision"."contract_version" = 'planning-calculation.v1'
          and "project_calculation_revision"."model_id" = 'wmee-solar'
          and "project_calculation_revision"."model_version" ~ '^[0-9]+\.[0-9]+\.[0-9]+([+-][a-z0-9.-]+)?$'
          and "project_calculation_revision"."source_revision" ~ '^[0-9a-f]{40}$'
          and "project_calculation_revision"."defaults_version" = 'wmee-planning-defaults.v1'
          and "project_calculation_revision"."quality" = 'server_reproduced_estimate'
          and "project_calculation_revision"."validation_status" = 'not_f4_reference_validated')
        or ("project_calculation_revision"."contract_version" = 'planning-calculation.v2'
          and "project_calculation_revision"."model_id" = 'wmee-solar'
          and "project_calculation_revision"."model_version" = '2.0.0'
          and "project_calculation_revision"."source_revision" = '6637feab232b265020fc4b257574df76a0b071bd'
          and "project_calculation_revision"."defaults_version" = 'wmee-planning-defaults.v2'
          and "project_calculation_revision"."quality" = 'server_reproduced_public_reference'
          and "project_calculation_revision"."validation_status" = 'f4_public_reference_validated')
      ));