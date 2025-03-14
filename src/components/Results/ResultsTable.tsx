import React from 'react';
import ResultRow from './ResultRow';
import { SearchResult } from '../../types';

interface ResultsTableProps {
  results: SearchResult[];
  isLoading: boolean;
}

const ResultsTable: React.FC<ResultsTableProps> = ({ results, isLoading }) => {
  return (
    <div className="overflow-x-auto">
      {/* Remove divide-y class to eliminate borders */}
      <table className="min-w-full text-xl">
        <thead className="">
          <tr>
            <th
              scope="col"
              className="px-6 text-right text-xs font-medium text-gray-500 tracking-wider w-1/6"
            >
              Text
            </th>
            <th
              scope="col"
              className="px-6 text-xs font-medium text-gray-500  tracking-wider w-5/6 text-center"
            >
                Result
            </th>
          </tr>
        </thead>
        {/* Remove divide-y class to eliminate borders between rows */}
        <tbody className="bg-white">
          {isLoading ? (
            // Loading placeholder rows
            Array.from({ length: 5 }).map((_, index) => (
              <tr key={`loading-${index}`} className="animate-pulse">
                <td className="px-6 py-2">
                  <div className="h-4 bg-gray-200 rounded w-3/4"></div>
                </td>
                <td className="px-6 py-2">
                  <div className="grid grid-cols-3 gap-2 mb-2">
                    <div className="h-4 bg-gray-200 rounded w-full"></div>
                    <div className="h-4 bg-gray-200 rounded w-full"></div>
                    <div className="h-4 bg-gray-200 rounded w-full"></div>
                  </div>
                </td>
              </tr>
            ))
          ) : (
            results.map((result) => (
              <ResultRow key={result.id} result={result} />
            ))
          )}
        </tbody>
      </table>
    </div>
  );
};

export default ResultsTable;