import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  displayCampusLabel,
  displayFoundationLabel,
  displayGradeLabel,
  formatStudentAudience,
  prettifyCode,
  audienceLabelsFromMaster,
} from '../src/lib/audienceLabels';

const labels = audienceLabelsFromMaster(
  [
    {
      name: '6',
      label: '6',
      divisions: [
        { name: 'SPORTSFOUNDATION', label: 'Sports Foundation' },
        { name: 'SCIENCEFOUNDATION', label: 'Science Foundation' },
      ],
    },
    {
      name: '7',
      label: 'Grade 7',
      divisions: [{ name: 'MAHAVEER', label: 'Mahaveer' }],
    },
  ],
  [
    { name: 'AIRPORTCAMPUS', label: 'Airport Campus' },
    { name: 'CITYCAMPUS', label: 'City Campus' },
  ],
);

test('prettifyCode inserts spaces in compact campus and foundation codes', () => {
  assert.equal(prettifyCode('AIRPORTCAMPUS'), 'Airport Campus');
  assert.equal(prettifyCode('SPORTSFOUNDATION'), 'Sports Foundation');
  assert.equal(prettifyCode('FINEARTSFOUNDATION'), 'Fine Arts Foundation');
  assert.equal(prettifyCode('CIVILFOUNDATION'), 'Civil Foundation');
  assert.equal(prettifyCode('OSMANPURACAMPUS'), 'Osmanpura Campus');
  assert.equal(prettifyCode('CITYCAMPUS'), 'City Campus');
  assert.equal(prettifyCode('CC'), 'CC');
  assert.equal(prettifyCode('A'), 'A');
  assert.equal(prettifyCode('MAHAVEER'), 'Mahaveer');
  assert.equal(prettifyCode('Airport Campus'), 'Airport Campus');
});

test('formatStudentAudience uses master-list labels with spaces', () => {
  assert.equal(
    formatStudentAudience('AIRPORTCAMPUS', '6', ['SPORTSFOUNDATION'], false, labels),
    'Airport Campus · Grade 6 · Sports Foundation',
  );
  assert.equal(
    formatStudentAudience('CITYCAMPUS', '7', ['MAHAVEER'], false, labels),
    'City Campus · Grade 7 · Mahaveer',
  );
  assert.equal(
    formatStudentAudience('AIRPORTCAMPUS', '6', [], true, labels),
    'Airport Campus · Grade 6 · all divisions',
  );
  // Stored codes without a master-list row still prettify.
  assert.equal(
    formatStudentAudience('OSMANPURACAMPUS', '8', ['CIVILFOUNDATION'], false),
    'Osmanpura Campus · Grade 8 · Civil Foundation',
  );
});

test('label helpers fall back cleanly', () => {
  assert.equal(displayCampusLabel('AIRPORTCAMPUS', labels), 'Airport Campus');
  assert.equal(displayGradeLabel('6', labels), 'Grade 6');
  assert.equal(displayGradeLabel('7', labels), 'Grade 7');
  assert.equal(displayFoundationLabel('6', 'SPORTSFOUNDATION', labels), 'Sports Foundation');
  assert.equal(displayCampusLabel('NORTHCAMPUS'), 'North Campus');
});
