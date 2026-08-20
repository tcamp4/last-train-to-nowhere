import type {
  GameState,
  PassengerConversationChoice,
  PassengerState,
} from '../shared/types';

export interface PassengerConversationResult {
  ok: boolean;
  passengerId: string;
  choice: PassengerConversationChoice;
  text: string;
  loyaltyDelta: number;
  moraleDelta: number;
  reason?: 'not-at-station' | 'unknown-passenger' | 'already-briefed';
}

interface ConversationResponse {
  text: string;
  loyalty: number;
  morale: number;
}

const RESPONSES: Readonly<
  Record<string, Readonly<Record<PassengerConversationChoice, ConversationResponse>>>
> = Object.freeze({
  'mara-vale': {
    support: {
      text: 'Mara: “Give me room at the broken panel and I will keep this engine breathing.”',
      loyalty: 7,
      morale: 3,
    },
    challenge: {
      text: 'Mara: “Hard deadlines? Fine. Keep up when I call for the next tool.”',
      loyalty: -2,
      morale: 8,
    },
  },
  'dr-ives': {
    support: {
      text: 'Dr. Ives: “Keep the medical bus alive and I can bring everyone home.”',
      loyalty: 6,
      morale: 5,
    },
    challenge: {
      text: 'Dr. Ives: “Triage is not cowardice. Ask me to choose quickly, not carelessly.”',
      loyalty: 2,
      morale: -4,
    },
  },
  'oren-brass': {
    support: {
      text: 'Oren: “Feed me a clean firing circuit and I will own the rear horizon.”',
      loyalty: 8,
      morale: 2,
    },
    challenge: {
      text: 'Oren: “You want faster reloads? Then stop flinching when the carriage bucks.”',
      loyalty: -3,
      morale: 9,
    },
  },
});

/** Health gates contribution; morale and loyalty independently scale effectiveness. */
export function passengerEffectiveness(passenger: PassengerState | undefined): number {
  if (!passenger || passenger.health <= 0) return 0;
  const health = clamp01(passenger.health / 100);
  const morale = clamp01(passenger.morale / 100);
  const loyalty = clamp01(passenger.loyalty / 100);
  return health * (0.25 + morale * 0.375 + loyalty * 0.375);
}

export function talkToPassenger(
  state: GameState,
  passengerId: string,
  choice: PassengerConversationChoice,
): PassengerConversationResult {
  if (state.mode !== 'station') {
    return failure(passengerId, choice, 'not-at-station', 'Crew briefings happen while the train is stopped.');
  }
  const passenger = state.passengers.find((candidate) => candidate.id === passengerId);
  const response = RESPONSES[passengerId]?.[choice];
  if (!passenger || !response) {
    return failure(passengerId, choice, 'unknown-passenger', 'No crew member answers that name.');
  }
  if (passenger.lastBriefingVisit === state.stationVisits) {
    return failure(
      passengerId,
      choice,
      'already-briefed',
      `${passenger.name} has already settled this stop's briefing.`,
    );
  }

  const previousLoyalty = passenger.loyalty;
  const previousMorale = passenger.morale;
  passenger.loyalty = clamp(passenger.loyalty + response.loyalty, 0, 100);
  passenger.morale = clamp(passenger.morale + response.morale, 0, 100);
  passenger.lastBriefingVisit = state.stationVisits;
  return {
    ok: true,
    passengerId,
    choice,
    text: response.text,
    loyaltyDelta: passenger.loyalty - previousLoyalty,
    moraleDelta: passenger.morale - previousMorale,
  };
}

function failure(
  passengerId: string,
  choice: PassengerConversationChoice,
  reason: NonNullable<PassengerConversationResult['reason']>,
  text: string,
): PassengerConversationResult {
  return { ok: false, passengerId, choice, text, loyaltyDelta: 0, moraleDelta: 0, reason };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

