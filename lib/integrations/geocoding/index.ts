export {
  AddressCandidateSchema,
  AddressPlaceIdSchema,
  AddressSearchQuerySchema,
  AddressSearchResultSchema,
  type AddressCandidate,
  type AddressSearchResult,
} from "./contract";

export {
  GeocodingInvalidResponseError,
  GeocodingProviderError,
  GeocodingRateLimitedError,
  GeocodingTimeoutError,
  GeocodingUnavailableError,
  resolveAddressCandidate,
  searchAddressCandidates,
  type GeocodingProviderErrorCode,
} from "./geoapify";

export {
  FixedWindowRateLimiter,
  handleAddressCandidateSearchRequest,
  type AddressCandidateSearchAccess,
  type AddressCandidateSearchAuthorizer,
  type AddressCandidateSearchDependencies,
  type AddressCandidateSearcher,
  type FixedWindowRateLimitDecision,
} from "./address-candidates-http";
