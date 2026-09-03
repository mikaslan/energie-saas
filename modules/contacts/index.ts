export {
  CONTACT_DATASET_VERSION,
  CONTACT_MAX_REVISION,
  CONTACT_UPDATE_COMMAND_VERSION,
  contactAddressV1Schema,
  contactDatasetV1Schema,
  contactMarketingConsentV1Schema,
  contactNameV1Schema,
  contactUpdateCommandV1Schema,
  contactUpdatePatchV1Schema,
  contactUtmV1Schema,
  contactWaysV1Schema,
} from "./contract";
export type {
  ContactAddressV1,
  ContactDatasetV1,
  ContactMarketingConsentV1,
  ContactNameV1,
  ContactUpdateCommandV1,
  ContactUpdatePatchV1,
  ContactUpdateResult,
  ContactUtmV1,
  ContactWaysV1,
} from "./contract";
export {
  ContactConflictError,
  ContactDeletedError,
  ContactNotFoundError,
  ContactValidationError,
} from "./errors";
export { getContactDataset, updateContact } from "./service";
