import { useState, useMemo, useCallback, useEffect } from 'react';

export interface UseBulkSelectionOptions<T> {
  /** All currently filtered records across all pages */
  items: T[];
  /** Currently visible records on the active page */
  paginatedItems: T[];
  /** Stable deterministic unique identifier extractor */
  getId: (item: T) => string;
  /** Optional reset key (e.g., when switching report type or sub-tab) */
  resetKey?: string | number;
}

export interface UseBulkSelectionResult<T> {
  selectedIds: Set<string>;
  selectedIdArray: string[];
  selectedItems: T[];
  selectedCount: number;
  totalFilteredCount: number;
  currentPageCount: number;
  isSelected: (id: string) => boolean;
  toggleOne: (id: string) => void;
  isPageAllSelected: boolean;
  isPageIndeterminate: boolean;
  isAllFilteredSelected: boolean;
  selectedBeyondPageCount: number;
  togglePageSelection: () => void;
  selectAllFilteredDirect: () => void;
  requestSelectAllFiltered: () => void;
  confirmSelectAllFiltered: () => void;
  cancelSelectAllFiltered: () => void;
  isCrossPageConfirmOpen: boolean;
  clearSelection: () => void;
  setSelectedIdList: (ids: string[]) => void;
}

export function useBulkSelection<T>({
  items,
  paginatedItems,
  getId,
  resetKey,
}: UseBulkSelectionOptions<T>): UseBulkSelectionResult<T> {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [isCrossPageConfirmOpen, setIsCrossPageConfirmOpen] = useState(false);

  // Reset cleanly when context switches (e.g., changing sub-tab or report type)
  useEffect(() => {
    setSelectedIds(new Set());
    setIsCrossPageConfirmOpen(false);
  }, [resetKey]);

  const validIdSet = useMemo(() => {
    const set = new Set<string>();
    for (const item of items) {
      const id = getId(item);
      if (id) set.add(id);
    }
    return set;
  }, [items, getId]);

  // Prune any selected IDs that are no longer present in the current dataset/filter
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Set<string>();
      prev.forEach((id) => {
        if (validIdSet.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [validIdSet]);

  const pageIds = useMemo(() => {
    const ids: string[] = [];
    for (const item of paginatedItems) {
      const id = getId(item);
      if (id) ids.push(id);
    }
    return ids;
  }, [paginatedItems, getId]);

  const pageSelectedCount = useMemo(() => {
    let count = 0;
    for (const id of pageIds) {
      if (selectedIds.has(id)) count++;
    }
    return count;
  }, [pageIds, selectedIds]);

  const isPageAllSelected = pageIds.length > 0 && pageSelectedCount === pageIds.length;
  const isPageIndeterminate = pageSelectedCount > 0 && pageSelectedCount < pageIds.length;

  const selectedItems = useMemo(() => {
    if (selectedIds.size === 0) return [];
    return items.filter((item) => selectedIds.has(getId(item)));
  }, [items, selectedIds, getId]);

  const selectedCount = selectedItems.length;
  const totalFilteredCount = validIdSet.size;
  const isAllFilteredSelected =
    totalFilteredCount > 0 && selectedCount === totalFilteredCount;

  const pageIdSet = useMemo(() => new Set(pageIds), [pageIds]);
  const selectedBeyondPageCount = useMemo(() => {
    if (selectedIds.size === 0) return 0;
    let extra = 0;
    selectedIds.forEach((id) => {
      if (!pageIdSet.has(id) && validIdSet.has(id)) {
        extra++;
      }
    });
    return extra;
  }, [selectedIds, pageIdSet, validIdSet]);

  const isSelected = useCallback((id: string) => selectedIds.has(id), [selectedIds]);

  const toggleOne = useCallback((id: string) => {
    if (!id) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const togglePageSelection = useCallback(() => {
    if (pageIds.length === 0) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allCurrentlyOnPage = pageIds.every((id) => next.has(id));
      if (allCurrentlyOnPage) {
        pageIds.forEach((id) => next.delete(id));
      } else {
        pageIds.forEach((id) => next.add(id));
      }
      return next;
    });
  }, [pageIds]);

  const selectAllFilteredDirect = useCallback(() => {
    setSelectedIds(new Set(validIdSet));
    setIsCrossPageConfirmOpen(false);
  }, [validIdSet]);

  const requestSelectAllFiltered = useCallback(() => {
    if (validIdSet.size === 0) return;
    // Require explicit confirmation whenever selection spans beyond current page
    if (validIdSet.size > pageIds.length) {
      setIsCrossPageConfirmOpen(true);
      return;
    }
    setSelectedIds(new Set(validIdSet));
  }, [validIdSet, pageIds.length]);

  const confirmSelectAllFiltered = useCallback(() => {
    setSelectedIds(new Set(validIdSet));
    setIsCrossPageConfirmOpen(false);
  }, [validIdSet]);

  const cancelSelectAllFiltered = useCallback(() => {
    setIsCrossPageConfirmOpen(false);
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setIsCrossPageConfirmOpen(false);
  }, []);

  const setSelectedIdList = useCallback((ids: string[]) => {
    const next = new Set<string>();
    for (const id of ids) {
      if (validIdSet.has(id)) next.add(id);
    }
    setSelectedIds(next);
  }, [validIdSet]);

  const selectedIdArray = useMemo(() => Array.from(selectedIds), [selectedIds]);

  return {
    selectedIds,
    selectedIdArray,
    selectedItems,
    selectedCount,
    totalFilteredCount,
    currentPageCount: pageIds.length,
    isSelected,
    toggleOne,
    isPageAllSelected,
    isPageIndeterminate,
    isAllFilteredSelected,
    selectedBeyondPageCount,
    togglePageSelection,
    selectAllFilteredDirect,
    requestSelectAllFiltered,
    confirmSelectAllFiltered,
    cancelSelectAllFiltered,
    isCrossPageConfirmOpen,
    clearSelection,
    setSelectedIdList,
  };
}
