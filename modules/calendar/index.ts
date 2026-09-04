export {
  APPOINTMENT_DESCRIPTION_MAX_LENGTH,
  APPOINTMENT_LOCATION_MAX_LENGTH,
  APPOINTMENT_TITLE_MAX_LENGTH,
  CALENDAR_CATEGORY_ITEM_VERSION,
  CALENDAR_CATEGORY_NAME_MAX_LENGTH,
  PROJECT_APPOINTMENT_COMMAND_VERSION,
  PROJECT_APPOINTMENT_ITEM_VERSION,
  PROJECT_APPOINTMENT_MAX_ATTENDEES,
  PROJECT_APPOINTMENT_MAX_REVISION,
  PROJECT_APPOINTMENT_RANGE_VERSION,
  appointmentTypes,
  calendarCategoryItemV1Schema,
  calendarItemV1Schema,
  projectAppointmentCommandV1Schema,
  projectAppointmentItemV1Schema,
  projectAppointmentRangeV1Schema,
} from "@/lib/integrations/calendar/contract";
export type {
  AppointmentType,
  CalendarCategoryItemV1,
  CalendarItemV1,
  ProjectAppointmentCommandResult,
  ProjectAppointmentCommandV1,
  ProjectAppointmentItemV1,
  ProjectAppointmentRangeV1,
} from "@/lib/integrations/calendar/contract";
export {
  AppointmentConflictError,
  AppointmentNotFoundError,
  AppointmentValidationError,
} from "./errors";
export {
  archiveCalendar,
  createTenancyCalendar,
  ensurePersonalCalendar,
  executeProjectAppointmentCommand,
  listProjectAppointments,
  listVisibleCalendars,
} from "./service";
