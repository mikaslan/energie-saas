ALTER TABLE "site_energy_profile" DROP CONSTRAINT "site_energy_profile_contract_ck";--> statement-breakpoint
ALTER TABLE "site_energy_profile" DROP CONSTRAINT "site_energy_profile_json_ck";--> statement-breakpoint
ALTER TABLE "project_requirement" DROP CONSTRAINT "project_requirement_json_ck";--> statement-breakpoint
ALTER TABLE "site_energy_profile" ADD CONSTRAINT "site_energy_profile_contract_ck" CHECK ("site_energy_profile"."schema_version" = 'site-energy-profile.v1'
        and "site_energy_profile"."input_mode" in ('consumption', 'property', 'roomwise', 'manual'));--> statement-breakpoint
ALTER TABLE "site_energy_profile" ADD CONSTRAINT "site_energy_profile_json_ck" CHECK ((
        jsonb_typeof("site_energy_profile"."profile") = 'object'
        and ("site_energy_profile"."profile" - array[
          'schemaVersion', 'inputMode', 'building', 'roofs', 'consumption',
          'existingAssets', 'provenance', 'propertyEstimate', 'rooms'
        ]::text[]) = '{}'::jsonb
        and "site_energy_profile"."profile"->>'schemaVersion' = "site_energy_profile"."schema_version"
        and "site_energy_profile"."profile"->>'inputMode' = "site_energy_profile"."input_mode"
        and jsonb_typeof("site_energy_profile"."profile"->'building') = 'object'
        and jsonb_typeof("site_energy_profile"."profile"->'roofs') = 'array'
        and jsonb_array_length("site_energy_profile"."profile"->'roofs') between 1 and 4
        and jsonb_typeof("site_energy_profile"."profile"->'consumption') = 'object'
        and jsonb_typeof("site_energy_profile"."profile"->'existingAssets') = 'object'
        and jsonb_typeof("site_energy_profile"."profile"->'provenance') = 'object'
        and case "site_energy_profile"."profile"->>'inputMode'
          when 'property' then (
            jsonb_typeof("site_energy_profile"."profile"->'propertyEstimate') = 'object'
            and (("site_energy_profile"."profile"->'propertyEstimate') - array[
              'heatingType', 'residentCount'
            ]::text[]) = '{}'::jsonb
            and ("site_energy_profile"."profile"->'propertyEstimate') ?& array['heatingType', 'residentCount']
            and "site_energy_profile"."profile"#>>'{propertyEstimate,heatingType}' in (
              'gas', 'oil', 'heat_pump', 'district_heating', 'direct_electric',
              'biomass', 'other'
            )
            and jsonb_typeof("site_energy_profile"."profile"#>'{propertyEstimate,residentCount}') = 'number'
            and "site_energy_profile"."profile"#>>'{propertyEstimate,residentCount}' ~ '^[0-9]+$'
            and ("site_energy_profile"."profile"#>>'{propertyEstimate,residentCount}')::integer between 1 and 20
            and not ("site_energy_profile"."profile" ? 'rooms')
            and ("site_energy_profile"."profile"#>>'{provenance,source}' is null
              or "site_energy_profile"."profile"#>>'{provenance,source}' = 'rechner_snapshot')
          )
          when 'roomwise' then (
            jsonb_typeof("site_energy_profile"."profile"->'rooms') = 'array'
            and jsonb_array_length("site_energy_profile"."profile"->'rooms') between 1 and 40
            and not ("site_energy_profile"."profile" ? 'propertyEstimate')
            and ("site_energy_profile"."profile"#>>'{provenance,source}' is null
              or "site_energy_profile"."profile"#>>'{provenance,source}' = 'rechner_snapshot')
          )
          when 'manual' then (
            not ("site_energy_profile"."profile" ? 'propertyEstimate')
            and not ("site_energy_profile"."profile" ? 'rooms')
            and "site_energy_profile"."profile"#>>'{provenance,source}' = 'operator_manual'
          )
          else (
            not ("site_energy_profile"."profile" ? 'propertyEstimate')
            and not ("site_energy_profile"."profile" ? 'rooms')
            and ("site_energy_profile"."profile"#>>'{provenance,source}' is null
              or "site_energy_profile"."profile"#>>'{provenance,source}' = 'rechner_snapshot')
          )
        end
      ) is true);--> statement-breakpoint
ALTER TABLE "project_requirement" ADD CONSTRAINT "project_requirement_json_ck" CHECK ((
        jsonb_typeof("project_requirement"."requirements") = 'object'
        and ("project_requirement"."requirements" - array[
          'schemaVersion', 'source', 'branch', 'requestedProducts', 'requestedPackages'
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
        and (
          not ("project_requirement"."requirements" ? 'requestedPackages')
          or (
            jsonb_typeof("project_requirement"."requirements"->'requestedPackages') = 'object'
            and (("project_requirement"."requirements"->'requestedPackages') - array[
              'solar', 'storage', 'wallbox', 'heating'
            ]::text[]) = '{}'::jsonb
            and ("project_requirement"."requirements"->'requestedPackages') ?& array[
              'solar', 'storage', 'wallbox', 'heating'
            ]
            and jsonb_typeof("project_requirement"."requirements"#>'{requestedPackages,solar}') = 'object'
            and jsonb_typeof("project_requirement"."requirements"#>'{requestedPackages,storage}') = 'object'
            and jsonb_typeof("project_requirement"."requirements"#>'{requestedPackages,wallbox}') = 'object'
            and jsonb_typeof("project_requirement"."requirements"#>'{requestedPackages,heating}') = 'object'
            and (("project_requirement"."requirements"#>'{requestedPackages,solar}') - array[
              'wanted', 'paymentKind'
            ]::text[]) = '{}'::jsonb
            and (("project_requirement"."requirements"#>'{requestedPackages,storage}') - array[
              'wanted', 'paymentKind'
            ]::text[]) = '{}'::jsonb
            and (("project_requirement"."requirements"#>'{requestedPackages,wallbox}') - array[
              'wanted', 'paymentKind'
            ]::text[]) = '{}'::jsonb
            and (("project_requirement"."requirements"#>'{requestedPackages,heating}') - array[
              'wanted', 'paymentKind'
            ]::text[]) = '{}'::jsonb
            and jsonb_typeof("project_requirement"."requirements"#>'{requestedPackages,solar,wanted}') = 'boolean'
            and jsonb_typeof("project_requirement"."requirements"#>'{requestedPackages,storage,wanted}') = 'boolean'
            and jsonb_typeof("project_requirement"."requirements"#>'{requestedPackages,wallbox,wanted}') = 'boolean'
            and jsonb_typeof("project_requirement"."requirements"#>'{requestedPackages,heating,wanted}') = 'boolean'
            and jsonb_typeof("project_requirement"."requirements"#>'{requestedPackages,solar,paymentKind}') in ('string', 'null')
            and jsonb_typeof("project_requirement"."requirements"#>'{requestedPackages,storage,paymentKind}') in ('string', 'null')
            and jsonb_typeof("project_requirement"."requirements"#>'{requestedPackages,wallbox,paymentKind}') in ('string', 'null')
            and jsonb_typeof("project_requirement"."requirements"#>'{requestedPackages,heating,paymentKind}') in ('string', 'null')
            and case "project_requirement"."requirements"#>>'{requestedPackages,solar,wanted}'
              when 'true' then "project_requirement"."requirements"#>>'{requestedPackages,solar,paymentKind}'
                in ('purchase', 'leasing', 'financing')
              else ("project_requirement"."requirements"#>>'{requestedPackages,solar,wanted}')::boolean = false
                and ("project_requirement"."requirements"#>'{requestedPackages,solar,paymentKind}') = 'null'::jsonb
            end
            and case "project_requirement"."requirements"#>>'{requestedPackages,storage,wanted}'
              when 'true' then "project_requirement"."requirements"#>>'{requestedPackages,storage,paymentKind}'
                in ('purchase', 'leasing', 'financing')
              else ("project_requirement"."requirements"#>>'{requestedPackages,storage,wanted}')::boolean = false
                and ("project_requirement"."requirements"#>'{requestedPackages,storage,paymentKind}') = 'null'::jsonb
            end
            and case "project_requirement"."requirements"#>>'{requestedPackages,wallbox,wanted}'
              when 'true' then "project_requirement"."requirements"#>>'{requestedPackages,wallbox,paymentKind}'
                in ('purchase', 'leasing', 'financing')
              else ("project_requirement"."requirements"#>>'{requestedPackages,wallbox,wanted}')::boolean = false
                and ("project_requirement"."requirements"#>'{requestedPackages,wallbox,paymentKind}') = 'null'::jsonb
            end
            and case "project_requirement"."requirements"#>>'{requestedPackages,heating,wanted}'
              when 'true' then "project_requirement"."requirements"#>>'{requestedPackages,heating,paymentKind}'
                in ('purchase', 'leasing', 'financing')
              else ("project_requirement"."requirements"#>>'{requestedPackages,heating,wanted}')::boolean = false
                and ("project_requirement"."requirements"#>'{requestedPackages,heating,paymentKind}') = 'null'::jsonb
            end
          )
        )
      ) is true);