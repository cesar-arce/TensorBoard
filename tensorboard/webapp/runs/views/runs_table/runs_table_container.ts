/* Copyright 2020 The TensorFlow Authors. All Rights Reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
==============================================================================*/
import {
  ChangeDetectionStrategy,
  Component,
  Input,
  OnDestroy,
  OnInit,
} from '@angular/core';
import {createSelector, Store} from '@ngrx/store';
import {combineLatest, Observable, of, Subject} from 'rxjs';
import {
  combineLatestWith,
  distinctUntilChanged,
  filter,
  map,
  switchMap,
  take,
  takeUntil,
} from 'rxjs/operators';
import * as alertActions from '../../../alert/actions';
import {areSameRouteKindAndExperiments} from '../../../app_routing';
import {State} from '../../../app_state';
import {actions as hparamsActions} from '../../../hparams';
import {
  getActiveRoute,
  getCurrentRouteRunSelection,
  getExperiment,
  getExperimentIdToExperimentAliasMap,
  getRunColorMap,
  getRuns,
  getRunSelectorRegexFilter,
  getRunsLoadState,
  getRunsTableFullScreen,
  getRunsTableHeaders,
  getRunsTableSortingInfo,
} from '../../../selectors';
import {DataLoadState, LoadState} from '../../../types/data';
import {
  ColumnHeader,
  FilterAddedEvent,
  SortingInfo,
  TableData,
} from '../../../widgets/data_table/types';
import {
  runColorChanged,
  runPageSelectionToggled,
  runSelectionToggled,
  runSelectorRegexFilterChanged,
  runsTableHeaderAdded,
  runsTableHeaderOrderChanged,
  runsTableHeaderRemoved,
  runsTableSortingInfoChanged,
  singleRunSelected,
} from '../../actions';
import {MAX_NUM_RUNS_TO_ENABLE_BY_DEFAULT} from '../../store/runs_types';
import {RunsTableColumn, RunTableItem} from './types';
import {
  getCurrentColumnFilters,
  getFilteredRenderableRuns,
  getPotentialHparamColumns,
} from '../../../metrics/views/main_view/common_selectors';
import {runsTableFullScreenToggled} from '../../../core/actions';
import {sortTableDataItems} from './sorting_utils';

const getRunsLoading = createSelector<
  State,
  {experimentId: string},
  LoadState,
  boolean
>(getRunsLoadState, (loadState) => loadState.state === DataLoadState.LOADING);

/**
 * Renders list of experiments.
 *
 * Note: all @Inputs are read once upon initialization. This component does not
 * update when input bindings change.
 */
@Component({
  selector: 'runs-table',
  template: `
    <runs-data-table
      [headers]="runsColumns$ | async"
      [data]="sortedRunsTableData$ | async"
      [selectableColumns]="selectableColumns$ | async"
      [columnFilters]="columnFilters$ | async"
      [sortingInfo]="sortingInfo$ | async"
      [experimentIds]="experimentIds"
      [regexFilter]="regexFilter$ | async"
      [isFullScreen]="runsTableFullScreen$ | async"
      [loading]="loading$ | async"
      (sortDataBy)="sortDataBy($event)"
      (orderColumns)="orderColumns($event)"
      (onSelectionToggle)="onRunSelectionToggle($event)"
      (onAllSelectionToggle)="onAllSelectionToggle($event)"
      (onRunColorChange)="onRunColorChange($event)"
      (onRegexFilterChange)="onRegexFilterChange($event)"
      (onSelectionDblClick)="onRunSelectionDblClick($event)"
      (toggleFullScreen)="toggleFullScreen()"
      (addColumn)="addColumn($event)"
      (removeColumn)="removeColumn($event)"
      (addFilter)="addHparamFilter($event)"
    ></runs-data-table>
  `,
  styles: [
    `
      :host {
        display: flex;
        position: relative;
      }

      tb-data-table {
        overflow-y: scroll;
        width: 100%;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RunsTableContainer implements OnInit, OnDestroy {
  sortedRunsTableData$: Observable<TableData[]> = of([]);
  loading$: Observable<boolean> | null = null;
  sortingInfo$ = this.store.select(getRunsTableSortingInfo);

  // Column to disable in the table. The columns are rendered in the order as
  // defined by this input.
  @Input()
  columns: RunsTableColumn[] = [RunsTableColumn.RUN_NAME];

  @Input() experimentIds!: string[];
  @Input() showHparamsAndMetrics = false;

  regexFilter$ = this.store.select(getRunSelectorRegexFilter);
  runsColumns$ = this.store.select(getRunsTableHeaders);
  runsTableFullScreen$ = this.store.select(getRunsTableFullScreen);

  selectableColumns$ = this.store.select(getPotentialHparamColumns).pipe(
    combineLatestWith(this.runsColumns$),
    map(([potentialColumns, currentColumns]) => {
      const currentColumnNames = new Set(currentColumns.map(({name}) => name));
      return potentialColumns.filter((columnHeader) => {
        return !currentColumnNames.has(columnHeader.name);
      });
    })
  );

  columnFilters$ = this.store.select(getCurrentColumnFilters);

  allRunsTableData$ = this.store.select(getFilteredRenderableRuns).pipe(
    map((filteredRenderableRuns) => {
      return filteredRenderableRuns.map((runTableItem) => {
        const tableData: TableData = {
          ...Object.fromEntries(runTableItem.hparams.entries()),
          id: runTableItem.run.id,
          run: runTableItem.run.name,
          experimentName: runTableItem.experimentName,
          experimentAlias: runTableItem.experimentAlias,
          selected: runTableItem.selected,
          color: runTableItem.runColor,
        };
        return tableData;
      });
    })
  );

  private readonly ngUnsubscribe = new Subject<void>();

  constructor(private readonly store: Store<State>) {}

  ngOnInit() {
    const getRunTableItemsPerExperiment = this.experimentIds.map((id) =>
      this.getRunTableItemsForExperiment(id)
    );

    this.sortedRunsTableData$ = combineLatest([
      this.allRunsTableData$,
      this.sortingInfo$,
    ]).pipe(
      map(([items, sortingInfo]) => {
        return sortTableDataItems(items, sortingInfo);
      })
    );

    const rawAllUnsortedRunTableItems$ = combineLatest(
      getRunTableItemsPerExperiment
    ).pipe(
      map((itemsForExperiments: RunTableItem[][]) => {
        const items = [] as RunTableItem[];
        return items.concat(...itemsForExperiments);
      })
    );

    const getRunsLoadingPerExperiment = this.experimentIds.map((id) => {
      return this.store.select(getRunsLoading, {experimentId: id});
    });
    this.loading$ = combineLatest(getRunsLoadingPerExperiment).pipe(
      map((experimentsLoading) => {
        return experimentsLoading.some((isLoading) => isLoading);
      })
    );

    /**
     * For consumers who show checkboxes, notify users that new runs may not be
     * selected by default.
     *
     * Warning: this pattern is not recommended in general. Dispatching
     * `alertReported` would be better handled in a Ngrx Reducer in response
     * to `fetchRunsSucceeded` or via the declared alert registrations using
     * `alertFromAction`. Unfortunately, those currently have no way of knowing
     * whether a run table is actually shown (with checkboxes), so we make a
     * special exception here. A more 'Ngrx pure' approach would require making
     * the store aware of the visibility of any run tables.
     */
    if (this.columns.includes(RunsTableColumn.CHECKBOX)) {
      const runsExceedLimitForRoute$ = this.store.select(getActiveRoute).pipe(
        takeUntil(this.ngUnsubscribe),
        distinctUntilChanged((prevRoute, currRoute) => {
          // Avoid showing it more than once per route, since it would be
          // annoying to see the alert on every auto-reload or when user
          // changes tabs.
          return areSameRouteKindAndExperiments(prevRoute, currRoute);
        }),
        switchMap(() => {
          return rawAllUnsortedRunTableItems$.pipe(
            filter((runTableItems: RunTableItem[]) => {
              return runTableItems.length > MAX_NUM_RUNS_TO_ENABLE_BY_DEFAULT;
            }),
            take(1)
          );
        })
      );
      runsExceedLimitForRoute$.subscribe(() => {
        const text =
          `The number of runs exceeds ` +
          `${MAX_NUM_RUNS_TO_ENABLE_BY_DEFAULT}. New runs are unselected ` +
          `for performance reasons.`;
        this.store.dispatch(
          alertActions.alertReported({localizedMessage: text})
        );
      });
    }
  }

  ngOnDestroy() {
    this.ngUnsubscribe.next();
    this.ngUnsubscribe.complete();
  }

  sortDataBy(sortingInfo: SortingInfo) {
    this.store.dispatch(runsTableSortingInfoChanged({sortingInfo}));
  }

  private getRunTableItemsForExperiment(
    experimentId: string
  ): Observable<RunTableItem[]> {
    return combineLatest([
      this.store.select(getRuns, {experimentId}),
      this.store.select(getExperiment, {experimentId}),
      this.store.select(getCurrentRouteRunSelection),
      this.store.select(getRunColorMap),
      this.store.select(getExperimentIdToExperimentAliasMap),
    ]).pipe(
      map(([runs, experiment, selectionMap, colorMap, experimentIdToAlias]) => {
        return runs.map((run) => {
          const hparamMap: RunTableItem['hparams'] = new Map();
          (run.hparams || []).forEach((hparam) => {
            hparamMap.set(hparam.name, hparam.value);
          });
          const metricMap: RunTableItem['metrics'] = new Map();
          (run.metrics || []).forEach((metric) => {
            metricMap.set(metric.tag, metric.value);
          });
          return {
            run,
            experimentName: experiment?.name || '',
            experimentAlias: experimentIdToAlias[experimentId],
            selected: Boolean(selectionMap && selectionMap.get(run.id)),
            runColor: colorMap[run.id],
            hparams: hparamMap,
            metrics: metricMap,
          };
        });
      })
    );
  }

  onRunSelectionToggle(id: string) {
    this.store.dispatch(
      runSelectionToggled({
        runId: id,
      })
    );
  }

  onRunSelectionDblClick(runId: string) {
    this.store.dispatch(
      singleRunSelected({
        runId,
      })
    );
  }

  onAllSelectionToggle(runIds: string[]) {
    this.store.dispatch(
      runPageSelectionToggled({
        runIds,
      })
    );
  }

  onRegexFilterChange(regexString: string) {
    this.store.dispatch(runSelectorRegexFilterChanged({regexString}));
  }

  onRunColorChange({runId, newColor}: {runId: string; newColor: string}) {
    this.store.dispatch(runColorChanged({runId, newColor}));
  }

  toggleFullScreen() {
    this.store.dispatch(runsTableFullScreenToggled());
  }

  addColumn({header, index}: {header: ColumnHeader; index: number}) {
    header.enabled = true;
    this.store.dispatch(
      runsTableHeaderAdded({header: {...header, enabled: true}, index})
    );
  }

  removeColumn(header: ColumnHeader) {
    this.store.dispatch(runsTableHeaderRemoved({header}));
  }

  orderColumns(newHeaderOrder: ColumnHeader[]) {
    this.store.dispatch(runsTableHeaderOrderChanged({newHeaderOrder}));
  }

  addHparamFilter(event: FilterAddedEvent) {
    this.store.dispatch(
      hparamsActions.dashboardHparamFilterAdded({
        name: event.name,
        filter: event.value,
      })
    );
  }
}

export const TEST_ONLY = {
  getRunsLoading,
};
