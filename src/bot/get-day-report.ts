import { getManagedAccountNumbers, getDefaultAccountNumber } from "~/core/default-account";
import {
  getAllDayReports,
  getAllDayReportsAcrossAccounts,
  getDayReportForDate,
  getLatestDayReport,
} from "./day-report-store";

export async function getDayReport(args: string[]): Promise<unknown> {
  const [accountNumberArg, dateArg] = args;
  const accountNumber = accountNumberArg?.trim() || null;
  const date = dateArg?.trim() || null;

  if (accountNumber && date) {
    return getDayReportForDate(accountNumber, date);
  }

  if (accountNumber) {
    return getAllDayReports(accountNumber);
  }

  if (date) {
    // Date-only: return report for that date across all managed accounts
    const accountNumbers = await getManagedAccountNumbers();
    const reports = await Promise.all(
      accountNumbers.map((acc) => getDayReportForDate(acc, date)),
    );
    return Object.fromEntries(accountNumbers.map((acc, i) => [acc, reports[i]]));
  }

  // No args: latest report for each managed account
  const accountNumbers = await getManagedAccountNumbers();
  if (accountNumbers.length === 1) {
    return getLatestDayReport(accountNumbers[0]);
  }

  const reports = await Promise.all(accountNumbers.map((acc) => getLatestDayReport(acc)));
  return Object.fromEntries(accountNumbers.map((acc, i) => [acc, reports[i]]));
}

export default getDayReport;
