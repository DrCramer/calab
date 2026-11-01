package office

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/httpx"
)

// «Сохранить как» of a legacy format (doc, xls, ppt → docx, xlsx, pptx): the Document Server's
// conversion service makes the new file, the API stores it as a NEW Disk item with its own id
// next to the source. The source item (its id, path, file and sha256) is never written: the
// bots keep their paths.

// ConvertTimeout bounds one conversion.
const ConvertTimeout = 90 * time.Second

var errNoConvert = httpx.Coded(http.StatusUnsupportedMediaType, v1.ErrorCode_ERROR_CODE_VALIDATION, "this file type is not converted")

// convertItem: POST /api/disk/items/{id}/office/convert.
func (s *Service) convertItem(w http.ResponseWriter, r *http.Request) error {
	id := auth.MustFromContext(r.Context())
	itemID, err := httpx.PathUUID(r, "id", "item")
	if err != nil {
		return err
	}
	if err := s.takeConvert(r); err != nil {
		return err
	}
	it, err := s.store.ItemFor(r.Context(), id.UserID, itemID)
	if errors.Is(err, ErrNotFound) {
		return httpx.NotFound("item")
	}
	if err != nil {
		return err
	}
	if it.Trashed {
		return httpx.Conflict("the item is in the trash")
	}
	tok, err := signURL(s.cfg.URLKey, opFile, it.ID, it.FileID, "", s.Now().Add(s.cfg.FileURLTTL))
	if err != nil {
		return err
	}
	return s.convert(w, r, it.WorkspaceID, it.ParentID, it.Name, it.FileID, it.Size, tok)
}

// convertFile: POST /api/workspaces/{id}/office/convert {file_id, parent_id} — an attachment.
func (s *Service) convertFile(w http.ResponseWriter, r *http.Request) error {
	ws, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	var req v1.OfficeConvertRequest
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	fileID, err := uuid.Parse(req.GetFileId())
	if err != nil {
		return httpx.Validation("file_id", "must be an id")
	}
	var parent *uuid.UUID
	if req.GetParentId() != "" {
		p, err := uuid.Parse(req.GetParentId())
		if err != nil {
			return httpx.Validation("parent_id", "must be an id")
		}
		parent = &p
	}
	if err := s.takeConvert(r); err != nil {
		return err
	}
	f, err := s.store.FileFor(r, fileID)
	if errors.Is(err, ErrNotFound) {
		return httpx.NotFound("file")
	}
	if err != nil {
		return err
	}
	tok, err := signURL(s.cfg.URLKey, opAttach, f.ID, uuid.Nil, "", s.Now().Add(s.cfg.FileURLTTL))
	if err != nil {
		return err
	}
	return s.convert(w, r, ws, parent, f.Name, f.ID, f.Size, tok)
}

func (s *Service) takeConvert(r *http.Request) error {
	id := auth.MustFromContext(r.Context())
	if id.IsBot || id.ViaBot != uuid.Nil {
		return auth.ErrBotNotAllowed
	}
	if s.ConvertLimit == nil {
		return nil
	}
	return s.ConvertLimit.Take(r.Context(), id.UserID.String())
}

// convert runs the conversion of the file at our URL token tok and files the result.
func (s *Service) convert(w http.ResponseWriter, r *http.Request, ws uuid.UUID, parent *uuid.UUID, name string, fileID uuid.UUID, size int64, tok string) error {
	src, ok := FormatOf(name)
	if !ok || src.ConvertTo == "" {
		return errNoConvert
	}
	if size > s.cfg.MaxSize {
		return s.tooLarge()
	}
	dst, _ := formatByExt(src.ConvertTo)
	ctx, cancel := context.WithTimeout(r.Context(), ConvertTimeout)
	defer cancel()
	fileURL, err := s.runConvert(ctx, src, dst, fileID, name, s.cfg.APIURL+"/api/office/file/"+tok)
	if err != nil {
		slog.WarnContext(ctx, "office: convert", "file", fileID, "err", err)
		return httpx.Coded(http.StatusBadGateway, v1.ErrorCode_ERROR_CODE_INTERNAL, "the document server could not convert the file")
	}
	body, err := s.fetch(ctx, fileURL)
	if err != nil {
		slog.WarnContext(ctx, "office: convert fetch", "file", fileID, "err", err)
		return httpx.Coded(http.StatusBadGateway, v1.ErrorCode_ERROR_CODE_INTERNAL, "the document server could not convert the file")
	}
	if err := dst.Check(body); err != nil {
		return httpx.Coded(http.StatusBadGateway, v1.ErrorCode_ERROR_CODE_INTERNAL, "the converted file is not "+dst.Ext)
	}
	newName := strings.TrimSuffix(name, name[len(name)-len(src.Ext)-1:]) + "." + dst.Ext
	item, err := s.store.AddFile(r, ws, parent, newName, dst, body)
	if err != nil {
		return err
	}
	slog.InfoContext(ctx, "office: converted", "user", auth.MustFromContext(r.Context()).UserID, "file", fileID, "item", item.GetId(), "to", dst.Ext)
	httpx.Write(w, http.StatusCreated, &v1.DiskItemResponse{Item: item})
	return nil
}

// runConvert asks the conversion service (POST {internal}/converter, async, polled with the
// same key) and returns the URL of the result.
func (s *Service) runConvert(ctx context.Context, src, dst Format, fileID uuid.UUID, title, fileURL string) (string, error) {
	req := map[string]any{
		"async": true, "filetype": src.Ext, "outputtype": dst.Ext, "key": viewKey(s.cfg.URLKey, "c-", fileID, dst.Ext),
		"title": title, "url": fileURL,
	}
	for {
		var res struct {
			EndConvert bool   `json:"endConvert"`
			FileURL    string `json:"fileUrl"`
			Percent    int    `json:"percent"`
			Error      int    `json:"error"`
		}
		if err := s.postDS(ctx, "/converter", req, &res); err != nil {
			return "", err
		}
		if res.Error != 0 {
			return "", fmt.Errorf("office: conversion error %d", res.Error)
		}
		if res.EndConvert && res.FileURL != "" {
			return res.FileURL, nil
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(s.ConvertPoll):
		}
	}
}

func mustUser(r *http.Request) uuid.UUID { return auth.MustFromContext(r.Context()).UserID }
