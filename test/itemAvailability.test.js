const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getEmptySchedule,
  isScheduleAvailableAt,
  validateAvailabilitySchedule,
} = require("../src/utils/itemAvailability");

test("acepta varios rangos separados el mismo día", () => {
  const schedule = getEmptySchedule();
  schedule.enabled = true;
  schedule.mon = [
    { from: "12:00", to: "15:00" },
    { from: "20:00", to: "23:30" },
  ];

  assert.equal(validateAvailabilitySchedule(schedule).error, undefined);
});

test("calcula horarios nocturnos en el huso de Buenos Aires", () => {
  const schedule = getEmptySchedule();
  schedule.enabled = true;
  schedule.mon = [{ from: "20:00", to: "02:00" }];

  // Martes 01:00 y 03:00 en Buenos Aires, respectivamente.
  assert.equal(isScheduleAvailableAt(schedule, new Date("2026-08-25T04:00:00Z")), true);
  assert.equal(isScheduleAvailableAt(schedule, new Date("2026-08-25T06:00:00Z")), false);
});

test("detecta solapamientos entre un rango nocturno y el día siguiente", () => {
  const schedule = getEmptySchedule();
  schedule.enabled = true;
  schedule.sun = [{ from: "23:00", to: "02:00" }];
  schedule.mon = [{ from: "01:00", to: "03:00" }];

  assert.match(validateAvailabilitySchedule(schedule).error, /superponerse/);
});

test("un horario activo requiere al menos un rango", () => {
  const schedule = getEmptySchedule();
  schedule.enabled = true;

  assert.match(validateAvailabilitySchedule(schedule).error, /al menos un horario/);
});
