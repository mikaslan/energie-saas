export {
  APPOINTMENT_DESCRIPTION_MAX_LENGTH,
  APPOINTMENT_LOCATION_MAX_LENGTH,
  APPOINTMENT_TITLE_MAX_LENGTH,
  CALENDAR_CATEGORY_ITEM_VERSION,
  CALENDAR_CATEGORY_NAME_MAX_LENGTH,
  PLANNING_BOARD_MAX_ROWS,
  PLANNING_BOARD_VERSION,
  PROJECT_APPOINTMENT_COMMAND_VERSION,
  PROJECT_APPOINTMENT_ITEM_VERSION,
  PROJECT_APPOINTMENT_MAX_ATTENDEES,
  PROJECT_APPOINTMENT_MAX_REVISION,
  PROJECT_APPOINTMENT_RANGE_VERSION,
  appointmentTypes,
  calendarCategoryItemV1Schema,
  calendarItemV1Schema,
  planningBoardDayCellSchema,
  planningBoardDtoSchema,
  planningBoardEntrySchema,
  planningBoardQuerySchema,
  planningBoardRowSchema,
  projectAppointmentCommandV1Schema,
  projectAppointmentItemV1Schema,
  projectAppointmentRangeV1Schema,
} from "@/lib/integrations/calendar/contract";
export {
  APPOINTMENT_TEMPLATE_SCHEMA_VERSION,
  applyAppointmentTemplateCommandSchema,
  archiveAppointmentTemplateCommandSchema,
  createAppointmentTemplateCommandSchema,
  appointmentTemplateDtoSchema,
  updateAppointmentTemplateCommandSchema,
} from "@/lib/integrations/calendar/template-contract";
export type {
  ApplyAppointmentTemplateCommand,
  AppointmentTemplateDto,
  ArchiveAppointmentTemplateCommand,
  CreateAppointmentTemplateCommand,
  UpdateAppointmentTemplateCommand,
} from "@/lib/integrations/calendar/template-contract";
export type {
  AppointmentType,
  CalendarCategoryItemV1,
  CalendarItemV1,
  PlanningBoardDto,
  PlanningBoardQuery,
  ProjectAppointmentCommandResult,
  ProjectAppointmentCommandV1,
  ProjectAppointmentItemV1,
  ProjectAppointmentRangeV1,
} from "@/lib/integrations/calendar/contract";
export type { UpcomingAppointmentV1 } from "./service";
export {
  AppointmentConflictError,
  AppointmentNotFoundError,
  AppointmentTemplateConflictError,
  AppointmentTemplateNotFoundError,
  AppointmentTemplateValidationError,
  AppointmentValidationError,
} from "./errors";
export {
  archiveCalendar,
  createTenancyCalendar,
  ensurePersonalCalendar,
  executeProjectAppointmentCommand,
  getPlanningBoard,
  listProjectAppointments,
  listUpcomingAppointments,
  listVisibleCalendars,
} from "./service";
export {
  applyAppointmentTemplate,
  archiveAppointmentTemplate,
  createAppointmentTemplate,
  listAppointmentTemplates,
  normalizeAppointmentTemplateName,
  restoreAppointmentTemplate,
  updateAppointmentTemplate,
} from "./templates";
