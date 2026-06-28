import tastytradeApi from "~/core/tastytrade-client";
import { getAccountMarginOrCash } from "~/core/default-account";
import {
  evaluatePositionGroup,
  groupPositionsByUnderlying,
  PositionGroupEvaluation,
} from "./evaluate-position";

export async function getPositionEvaluations(
  accountNumber: string,
): Promise<PositionGroupEvaluation[]> {
  const accountType = await getAccountMarginOrCash(accountNumber);
  const currentPositions =
    await tastytradeApi.balancesAndPositionsService.getPositionsList(
      accountNumber,
    );

  const groupedPositions = groupPositionsByUnderlying(currentPositions);
  const groupedEvaluations = await Promise.all(
    Array.from(groupedPositions.values()).map((positions) =>
      evaluatePositionGroup(positions, new Date(), accountType),
    ),
  );

  return groupedEvaluations.filter(
    (evaluation): evaluation is PositionGroupEvaluation => evaluation != null,
  );
}

export default getPositionEvaluations;
