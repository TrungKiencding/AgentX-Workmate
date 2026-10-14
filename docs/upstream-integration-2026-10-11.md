# Đánh giá và tích hợp upstream — 11/10/2026

## Phạm vi

- Nhánh đích: `version-1.1.0`; điểm xuất phát: `2e0fe184a5`.
- Upstream đã fetch: remote `upstream` (`git remote get-url upstream`), `main` tại `79b45d1647` (11/10/2026).
- Sàng lọc danh sách 12.991 commit first-parent từ 16/09/2026: nội dung commit, đường dẫn, kích thước, các bản đã được cherry-pick và phụ thuộc. Đây là sàng lọc danh mục; không khẳng định đã đọc từng dòng của cả 12.991 commit.
- Đọc và tích hợp 31 bản vá ưu tiên cùng các bản hoàn thiện cần thiết. Một số bản bổ trợ cũ hơn được lấy để khép kín nhóm sửa. Giữ tác giả upstream bằng `cherry-pick -x`; xử lý xung đột ngay trên giao diện hiện có của AgentX.
- Thực hiện trên `codex/upstream-hermes-20261011`, sau kiểm thử mới fast-forward nhánh đích. Không push remote.

## Các nhóm được chọn

| Nhóm | Giá trị đối với người dùng | Cách tích hợp và kiểm chứng |
|---|---|---|
| Redaction | Che khóa `sk-` có dấu chấm, khóa Zhipu, bí mật trong Python repr; tránh regex Telegram chạy quá lâu trên dữ liệu số lớn | Giữ chính sách bảo vệ nội dung file và cấu hình của AgentX. Kiểm tra idempotence, nội dung vô hại, chế độ tắt redaction và hiệu năng dữ liệu lớn |
| Báo cáo chẩn đoán | Khóa fallback và thông tin xác thực URL không lọt vào dump/debug/share | Che theo tên trường trước khi chuyển cấu hình thành text; strict URL redaction chỉ ở ranh giới chẩn đoán. Kiểm tra file cấu hình thật trong home tạm và nội dung tới upload sink mô phỏng |
| Tool-call JSON | Sửa ngoặc thiếu hoặc sai thứ tự, kể cả khi chuỗi chứa ngoặc | Giữ pipeline sửa hiện có; bổ sung bộ cân bằng dùng stack. Kiểm tra trực tiếp parser và đường streaming của AIAgent |
| Search files | `path` rỗng/null dùng thư mục hiện tại đúng như mô tả tool | Chỉ chuẩn hóa None/chuỗi trắng; giữ lỗi kiểu dữ liệu khác. Chạy registered handler tới môi trường local và file thật |
| MCP OAuth | Hiển thị đúng lỗi flow; cache JSON không phải object không làm crash đăng nhập | Sửa loader chung cho token/client/metadata; kiểm tra cả redirect URI có port lỗi và schema sai bằng cache file thật |
| Cấu hình phiên | Session ID hết hiệu lực không biến thay đổi model/fast/yolo/reasoning thành thay đổi toàn cục | Trả mã 4001 ở seam `config.set`; kiểm tra config byte-stable và môi trường tiến trình không đổi; giữ explicit global scope |
| Compression | Hướng dẫn dùng đúng heading lịch sử; worker TimeoutError không làm vòng chờ quay nóng; manual compress dùng cwd của phiên | Giữ fence, cancellation và commit semantics của fork. Kiểm tra worker thread thật, lỗi commit, progress của worker còn sống, prompt tạo thực và cleanup cwd khi thành công/lỗi |
| TTS | Không đọc phần reasoning chưa đóng; khóa Gemini nằm trong header | Dùng chung danh sách tag của scrubber hiện có; sửa cả sync và streaming, không đưa module provider đã tách của upstream vào fork |
| Tiến trình nền | Dừng cả tiến trình con sinh ra trong khoảng chờ SIGTERM | Chụp lại descendants trước khi kill, giữ parent cuối danh sách. Tái hiện bằng subprocess thật với signal handler sinh child sau SIGTERM; giữ kiểm tra quyền sở hữu PID và nhánh Windows |
| Video và Codex runtime | Endpoint video local/custom không bị system proxy nuốt; lỗi crash Codex không mất stderr | Tái sử dụng HTTP client policy hiện có; kiểm tra proxy construction và subprocess thật với stderr reader bị trì hoãn |
| Auxiliary Gemini | Nhận diện lỗi structured-output để fallback đúng | Dùng predicate hiện có thay vì thêm helper thuộc refactor upstream; kiểm tra cả các trường hợp không nên retry |

## Các nhóm để lại cho đợt riêng

| Nhóm / ví dụ commit | Quyết định và lý do |
|---|---|
| Tách SessionDB, WAL/holder/schema (`16fe260aab`, `8ac45786bf`, `c871622858`) | Không lấy lẻ: upstream đã chuyển sang nhiều module mà fork chưa có. Cần migration và kiểm tra dữ liệu/resume đủ chuỗi |
| Signed reasoning replay Anthropic/Bedrock (`79b45d1647` và chuỗi trước đó) | Không lấy lẻ: liên quan serialization, provider và resume; cần kiểm tra đủ transport và history, tránh làm hỏng các phiên đang lưu |
| Multiplex/secret scope (`2c3a75beaa` và các phụ thuộc) | Cần thiết kế đối chiếu với compute-host/profile của AgentX; không ghép thêm hạ tầng chỉ để một patch áp dụng được |
| Cron DST/quota/retry (`e3618cdec2`, `e85291e27b`, `e7bff4b6d8`) | Mã scheduler/schema hiện có khác đáng kể; phải kiểm tra pin-model, quota và retry như một nhóm riêng |
| Desktop/auth/updater/onboarding upstream | Không thay thế luồng AI Gateway, SSO và cập nhật/bảo toàn dữ liệu riêng của AgentX. Cần migration sản phẩm, không phải giải quyết conflict văn bản |
| Tool registry/cache (`30cd1e97d0`, `c191c34566`, `774df367ee`) | Fork đã có lookup O(1); các patch còn lại dựa trên tool-cache/scope kiến trúc khác. Không thay đổi toolset mid-conversation |
| TTS cleanup output (`7085fbf775`) | Call path của fork khác premise của upstream; cần thiết kế atomic output và kiểm thử tài sản có sẵn thay vì chép logic xóa file |
| Catalog/provider/skill và tích hợp mới quy mô lớn | Không ưu tiên trong đợt ổn định này; xét riêng theo tính tương thích với cấu hình/provider của AgentX |

## Kiểm thử

- Acceptance cuối trên 34 file liên quan: **1.353 passed, 0 failed**, canonical runner `scripts/run_tests.sh -j 4` (32,8 giây). Bao gồm SDK MCP thật với cache/home tạm, local file search, subprocess và stream/cancellation paths.
- Desktop: `npm run typecheck` đạt; 5 file về recovery, target-session, prompt-actions và slash palette: **154 passed**.
- Kiểm tra lint theo cấu hình dự án và `git diff --check`: đạt. Không thêm model tool, schema, behavioral env var, migration dữ liệu hoặc dependency sản phẩm.
- Tái hiện trên checkout gốc: nhóm hồi quy đầu có **38 trường hợp thất bại**; kiểm tra bổ sung session cwd/scope và stderr crash có **7/7 thất bại**; JSON repair có **7 trường hợp thất bại**. Các lượt có một phần ca trùng nhau, không cộng tổng như các lỗi độc lập. Những nhóm này đều đạt trong acceptance cuối.
- Bộ rộng trong workspace: `scripts/run_tests.sh -j 8 --file-timeout 120`, **2.970 file, 32.337 passed, 197 failed**, 41 file không chạy được test. Không diễn giải lượt này là xanh.
- Chạy lại toàn bộ 108 file thất bại trong hai checkout sạch, cùng Python 3.11.15 và cùng môi trường thư viện. Nhiều lỗi import ở lượt đầu biến mất sau khi các thư viện tùy chọn được lazy-install; scanner đọc raw config trong workspace còn đi vào các worktree `.claude` có sẵn. Không xóa/sửa các worktree của người dùng để làm test xanh.
- Kết quả đối chiếu cuối được ghi bên dưới. Hai kiểm thử cũ giữ username URL đã được sửa để yêu cầu che toàn bộ userinfo, phù hợp chính sách chẩn đoán mới; không làm yếu assertion kiểm tra bí mật.

Giới hạn: chưa thực hiện cuộc gọi cloud có phí, thử âm thanh qua thiết bị thật hoặc chạy trên máy Windows native. Unit/contract tests cho nhánh Windows vẫn được bộ rộng thực thi khi không bị skip bởi nền tảng. Không khẳng định toàn bộ nền mã hiện tại sạch lỗi; mục tiêu kiểm chứng ở đây là không thêm regression từ đợt tích hợp này.

## Kết quả đối chiếu cuối

Trên 108 file chạy lại ở checkout sạch của bản tích hợp: **1.730 passed, 119 failed**, **13 file lỗi import/collection**. Toàn bộ **132 ID thất bại** (119 test + 13 file collection) cũng có trên checkout gốc; **không có ID thất bại mới** sau khi sửa các assertion URL cũ. Riêng file metadata trên baseline được chạy lại tuần tự do lượt song song gặp race khi pytest dọn thư mục tạm; 3 lỗi lệch pin tái hiện đầy đủ.

Các lỗi nền gồm pin packaging/lazy-deps/lockfile lệch nhau, các assertion về model/provider đã cũ, một số hành vi gateway/CLI/video đã hỏng từ trước, và thiếu thư viện ACP/Hindsight/setuptools trong môi trường. Chúng được ghi nhận, không bị giấu bằng cách bỏ test hoặc đổi implementation ngoài phạm vi.

<details>
<summary>Các test thất bại có sẵn trên bản gốc (119 trường hợp)</summary>

- `tests/acp/test_auth.py::TestBuildAuthMethods::test_build_auth_methods_returns_provider_and_terminal_when_configured`
- `tests/acp/test_edit_approval.py::test_acp_permission_tool_call_uses_edit_kind_and_diff_content`
- `tests/agent/test_auxiliary_named_custom_providers.py::TestProvidersDictApiModeAnthropicMessages::test_resolve_provider_client_returns_anthropic_client`
- `tests/agent/test_auxiliary_transport_autodetect.py::test_resolve_provider_client_kimi_coding_wraps_anthropic`
- `tests/agent/test_close_interrupted_tool_sequence.py::test_closing_makes_next_user_message_alternation_safe`
- `tests/agent/test_codex_app_server_persist.py::test_codex_success_flushes_and_reports_persisted`
- `tests/agent/test_command_token_source.py::TestCallableKeyGetsBearerAuth::test_callable_takes_the_bearer_hook_path`
- `tests/agent/test_empty_tool_name_loop_dampening.py::test_mixed_batch_preserves_tool_call_result_pairing`
- `tests/agent/test_micro_compaction.py::TestMicroCompaction::test_cumulative_savings_accumulate_across_passes`
- `tests/agent/test_model_metadata.py::TestGrok46StaleCacheGuard::test_stale_grok_4_6_detected_by_generic_guard`
- `tests/agent/test_model_metadata.py::TestGrok46StaleCacheGuard::test_stale_grok_4_6_dropped_and_reresolves_to_500k`
- `tests/agent/test_model_metadata_local_ctx.py::TestQueryLocalContextLengthMaxTokensNotContext::test_models_list_max_tokens_only_returns_none`
- `tests/agent/test_nous_portal_anthropic_wire.py::TestClientShape::test_portal_bearer_does_not_also_send_env_anthropic_api_key`
- `tests/agent/test_nous_portal_anthropic_wire.py::TestClientShape::test_portal_jwt_authenticates_with_bearer_not_x_api_key`
- `tests/agent/test_set_runtime_main_custom_provider.py::TestResolveAutoCustomEndToEnd::test_named_custom_anthropic_messages_keeps_full_name_and_url`
- `tests/agent/test_vision_routing_31179.py::TestTextOnlyMainSkippedForVision::test_text_only_main_skipped_when_no_aggregator`
- `tests/agent/test_vision_routing_31179.py::TestTextOnlyMainSkippedForVision::test_vision_capable_main_used`
- `tests/cli/test_cli_interrupt_ack_race.py::test_chat_clears_previous_turn_persistence_override_before_staging`
- `tests/computer_use/test_cua_cli_fallback_env.py::test_cli_fallback_strips_provider_secret_from_subprocess_env`
- `tests/computer_use/test_cua_spawn_env_sanitization.py::test_cli_fallback_sanitizes_env_and_hides_console_on_windows`
- `tests/computer_use/test_cua_spawn_env_sanitization.py::test_doctor_sanitized_env_helper`
- `tests/computer_use/test_cua_spawn_env_sanitization.py::test_doctor_spawn_sanitizes_env_and_hides_console_on_windows`
- `tests/computer_use/test_cua_spawn_env_sanitization.py::test_permissions_run_sanitizes_env`
- `tests/computer_use/test_cua_spawn_env_sanitization.py::test_resolve_mcp_invocation_sanitizes_env`
- `tests/computer_use/test_cua_spawn_env_sanitization.py::test_update_check_sanitizes_env`
- `tests/cron/test_cleanup_timeout.py::test_run_job_bounds_sessiondb_finalization`
- `tests/cron/test_cron_no_agent.py::test_agent_provider_timeout_delivery_keeps_fallback_guidance`
- `tests/cron/test_cron_no_agent.py::test_timed_out_no_agent_script_delivery_is_not_mislabeled_as_provider_failure`
- `tests/cron/test_terminal_job_rearm.py::test_completed_oneshot_trigger_is_refused_and_disk_record_is_unchanged`
- `tests/cron/test_terminal_job_rearm.py::test_exhausted_recurring_job_trigger_is_refused`
- `tests/cron/test_terminal_job_rearm.py::test_terminal_jobs_are_not_due_or_advanced`
- `tests/cron/test_terminal_job_rearm.py::test_terminal_refusal_survives_reload`
- `tests/cron/test_terminal_job_rearm.py::test_update_cannot_reactivate_terminal_record`
- `tests/gateway/test_completion_session_boundary.py::test_completion_after_idle_end_still_delivers`
- `tests/gateway/test_wecom_callback.py::TestWecomCallbackEventConstruction::test_build_event_extracts_text_message`
- `tests/gateway/test_wecom_callback.py::TestWecomCallbackPollLoop::test_poll_loop_dispatches_handle_message`
- `tests/plugins/browser/test_browser_provider_plugins.py::TestPickerIntegration::test_picker_rows_match_registered_plugins`
- `tests/plugins/memory/test_hindsight_provider.py::TestConfig::test_get_client_passes_idle_timeout_to_hindsight_embedded`
- `tests/plugins/memory/test_hindsight_provider.py::TestPrefetchServerRetainVisibility::test_operation_notfound_treated_as_complete`
- `tests/plugins/memory/test_hindsight_provider.py::TestPrefetchServerRetainVisibility::test_prefetch_proceeds_after_server_wait_timeout`
- `tests/plugins/memory/test_hindsight_provider.py::TestPrefetchServerRetainVisibility::test_prefetch_waits_for_server_completion_before_recall`
- `tests/plugins/memory/test_hindsight_provider.py::TestPrefetchServerRetainVisibility::test_timed_out_ops_are_dropped_not_repolled`
- `tests/plugins/memory/test_hindsight_provider.py::TestPrefetchServerRetainVisibility::test_transient_status_error_keeps_waiting`
- `tests/plugins/test_teams_pipeline_plugin.py::TestTeamsMeetingPipeline::test_duplicate_notification_reuses_completed_job[asyncio]`
- `tests/plugins/test_teams_pipeline_plugin.py::TestTeamsMeetingPipeline::test_missing_transcript_and_recording_schedules_retry[asyncio]`
- `tests/plugins/test_teams_pipeline_plugin.py::TestTeamsMeetingPipeline::test_recording_fallback_uses_stt_and_updates_sink_records[asyncio]`
- `tests/plugins/test_teams_pipeline_plugin.py::TestTeamsMeetingPipeline::test_transcript_first_path_persists_state_and_skips_recording[asyncio]`
- `tests/plugins/video_gen/test_fal_plugin.py::TestFamilyRouting::test_default_family_text_routing`
- `tests/plugins/video_gen/test_fal_plugin.py::TestFamilyRouting::test_image_to_video_routes_to_image_endpoint`
- `tests/plugins/video_gen/test_fal_plugin.py::TestFamilyRouting::test_premium_seedance_routing`
- `tests/plugins/video_gen/test_fal_plugin.py::TestFamilyRouting::test_text_to_video_routes_to_text_endpoint`
- `tests/plugins/video_gen/test_fal_plugin.py::TestFamilyRouting::test_unknown_family_falls_back_to_default`
- `tests/plugins/video_gen/test_fal_plugin.py::TestUpscalePass::test_no_upscale_by_default`
- `tests/plugins/video_gen/test_fal_plugin.py::TestUpscalePass::test_upscale_chains_seedvr`
- `tests/plugins/video_gen/test_fal_plugin.py::TestUpscalePass::test_upscale_failure_falls_back_to_native`
- `tests/run_agent/test_compression_budget_refund.py::TestCompressionBudgetRefund::test_marathon_turn_compacts_past_the_per_turn_cap`
- `tests/run_agent/test_message_sequence_repair.py::test_sanitize_dedup_drops_tool_calls_key_when_all_removed`
- `tests/run_agent/test_message_sequence_repair.py::test_sanitize_keeps_result_keyed_on_composite_bridge_id`
- `tests/run_agent/test_nous_fallback_unavailable.py::TestNousFallbackLocalAvailability::test_present_nous_token_allows_activation`
- `tests/run_agent/test_run_agent.py::TestAnthropicInterruptHandler::test_interruptible_anthropic_interrupt_never_closes_shared_client`
- `tests/run_agent/test_run_agent.py::TestBuildSystemPrompt::test_memory_guidance_when_memory_tool_loaded`
- `tests/run_agent/test_run_agent.py::TestRunConversation::test_interrupt_during_stream_preserves_partial_assistant_text`
- `tests/run_agent/test_streaming.py::TestAnthropicStreamCallbacks::test_anthropic_eventless_sdk_assertion_normalized_to_empty_stream`
- `tests/run_agent/test_streaming.py::TestAnthropicStreamCallbacks::test_anthropic_stream_parser_valueerror_retries_before_delivery`
- `tests/run_agent/test_streaming.py::TestAnthropicStreamCallbacks::test_generic_anthropic_valueerror_still_propagates_without_stream_retry`
- `tests/run_agent/test_switch_model_reasoning_override.py::TestSwitchModelReasoningOverride::test_primary_runtime_includes_reasoning_config`
- `tests/run_agent/test_switch_model_reasoning_override.py::TestSwitchModelReasoningOverride::test_restore_primary_runtime_restores_reasoning`
- `tests/test_classify_api_error_hook.py::test_helper_exception_never_breaks_classification`
- `tests/test_classify_api_error_hook.py::test_invalid_reason_falls_through_to_builtin`
- `tests/test_classify_api_error_hook.py::test_no_hook_falls_through_to_builtin`
- `tests/test_classify_api_error_hook.py::test_non_dict_results_ignored`
- `tests/test_lazy_secrets_import.py::TestLazySecretsImport::test_secrets_dispatch_loads_cryptography_only_on_demand`
- `tests/test_lazy_secrets_import.py::TestLazySecretsImport::test_secrets_parser_does_not_load_cryptography`
- `tests/test_lazy_secrets_import.py::TestLazySecretsImport::test_update_command_no_cryptography`
- `tests/test_managed_runtime_resolution.py::test_no_unreviewed_bare_managed_runtime_lookups`
- `tests/test_packaging_build_guard.py::test_artifact_build_allows_explicit_nix_package_build_marker[sdist-agentx_workmate-*.tar.gz]`
- `tests/test_packaging_build_guard.py::test_artifact_build_allows_explicit_nix_package_build_marker[wheel-agentx_workmate-*.whl]`
- `tests/test_packaging_build_guard.py::test_artifact_build_rejects_nix_development_shell_environment[sdist]`
- `tests/test_packaging_build_guard.py::test_artifact_build_rejects_nix_development_shell_environment[wheel]`
- `tests/test_project_metadata.py::test_every_lazy_deps_exact_pin_matches_uv_lock`
- `tests/test_project_metadata.py::test_huggingface_hub_lazy_pin_matches_uv_lock`
- `tests/test_project_metadata.py::test_pyproject_pins_match_lazy_deps_pins`
- `tests/test_wal_checkpoint_strategy.py::TestVacuumUsesPassive::test_vacuum_uses_passive_before_vacuum`
- `tests/tools/test_daytona_environment.py::TestCleanup::test_cleanup_swallows_errors`
- `tests/tools/test_daytona_environment.py::TestCleanup::test_persistent_cleanup_stops_sandbox`
- `tests/tools/test_daytona_environment.py::TestCwdResolution::test_default_cwd_resolves_home`
- `tests/tools/test_daytona_environment.py::TestCwdResolution::test_empty_home_keeps_default_cwd`
- `tests/tools/test_daytona_environment.py::TestEnsureSandboxReady::test_no_restart_when_running`
- `tests/tools/test_daytona_environment.py::TestEnsureSandboxReady::test_restarts_stopped_sandbox`
- `tests/tools/test_daytona_environment.py::TestExecute::test_basic_command`
- `tests/tools/test_daytona_environment.py::TestExecute::test_daytona_error_triggers_retry`
- `tests/tools/test_daytona_environment.py::TestInterrupt::test_interrupt_stops_sandbox_and_returns_130`
- `tests/tools/test_daytona_environment.py::TestPersistence::test_non_persistent_skips_lookup`
- `tests/tools/test_daytona_environment.py::TestPersistence::test_persistent_resumes_via_get`
- `tests/tools/test_daytona_environment.py::TestResourceConversion::test_memory_converted_to_gib`
- `tests/tools/test_daytona_environment.py::TestResourceConversion::test_small_values_clamped_to_1`
- `tests/tools/test_daytona_environment.py::TestRetryExhausted::test_both_attempts_fail`
- `tests/tools/test_daytona_environment.py::TestSyncSafety::test_single_upload_quotes_parent_path`
- `tests/tools/test_image_generation.py::TestManagedGatewayErrorTranslation::test_4xx_translates_to_value_error_with_remediation`
- `tests/tools/test_image_generation.py::TestManagedGatewayErrorTranslation::test_non_http_exception_from_managed_bubbles_up`
- `tests/tools/test_managed_media_gateways.py::test_managed_fal_submit_uses_gateway_origin_and_nous_token`
- `tests/tools/test_modal_snapshot_isolation.py::test_modal_environment_migrates_legacy_snapshot_key_and_uses_snapshot_id`
- `tests/tools/test_modal_snapshot_isolation.py::test_resolve_modal_image_uses_snapshot_ids_and_registry_images`
- `tests/tools/test_video_generation_tool_surface_matrix.py::test_fal_text_only_routes_to_text_endpoint[flux-3]`
- `tests/tools/test_video_generation_tool_surface_matrix.py::test_fal_text_only_routes_to_text_endpoint[gemini-omni-flash]`
- `tests/tools/test_video_generation_tool_surface_matrix.py::test_fal_text_only_routes_to_text_endpoint[grok-imagine-1.5]`
- `tests/tools/test_video_generation_tool_surface_matrix.py::test_fal_text_only_routes_to_text_endpoint[happy-horse]`
- `tests/tools/test_video_generation_tool_surface_matrix.py::test_fal_text_only_routes_to_text_endpoint[kling-v3-4k]`
- `tests/tools/test_video_generation_tool_surface_matrix.py::test_fal_text_only_routes_to_text_endpoint[ltx-2.3]`
- `tests/tools/test_video_generation_tool_surface_matrix.py::test_fal_text_only_routes_to_text_endpoint[minimax-h3]`
- `tests/tools/test_video_generation_tool_surface_matrix.py::test_fal_text_only_routes_to_text_endpoint[pixverse-v6]`
- `tests/tools/test_video_generation_tool_surface_matrix.py::test_fal_text_only_routes_to_text_endpoint[seedance-2.0-mini]`
- `tests/tools/test_video_generation_tool_surface_matrix.py::test_fal_text_only_routes_to_text_endpoint[seedance-2.0]`
- `tests/tools/test_video_generation_tool_surface_matrix.py::test_fal_text_only_routes_to_text_endpoint[seedance-2.5]`
- `tests/tools/test_video_generation_tool_surface_matrix.py::test_fal_text_only_routes_to_text_endpoint[veo3.1]`
- `tests/tools/test_video_generation_tool_surface_matrix.py::test_tool_model_arg_overrides_config`
- `tests/tools/test_video_generation_tool_surface_matrix.py::test_tool_model_arg_with_image_url_routes_to_override_image_endpoint`
- `tests/tools/test_web_tools_config.py::TestParallelClientConfig::test_creates_client_with_key`
- `tests/tools/test_web_tools_config.py::TestParallelClientConfig::test_singleton_returns_same_instance`

</details>

<details>
<summary>Các file lỗi import/collection có sẵn (13 file)</summary>

- `tests/acp/test_entry.py`
- `tests/acp/test_events.py`
- `tests/acp/test_license_compress.py`
- `tests/acp/test_mcp_e2e.py`
- `tests/acp/test_named_provider_catalogs.py`
- `tests/acp/test_permissions.py`
- `tests/acp/test_ping_suppression.py`
- `tests/acp/test_server.py`
- `tests/acp/test_tools.py`
- `tests/acp_adapter/test_acp_commands.py`
- `tests/acp_adapter/test_acp_images.py`
- `tests/acp_adapter/test_acp_mcp_discovery.py`
- `tests/acp_adapter/test_acp_set_model_explicit_provider.py`

</details>

## Danh sách commit upstream đã lấy

Các SHA dưới đây trỏ về commit gốc. Những module refactor không có trong fork không được đưa vào chỉ để thỏa mãn patch; các test phụ thuộc helper upstream cũng được chuyển sang kiểm chứng call path thực của AgentX.

- [`66cc3f165d`](https://github.com/NousResearch/hermes-agent/commit/66cc3f165d2f0fd444ce93c8ce8aeb7502a4bd2b): fix(tools): normalize blank search paths
- [`ba96e68d47`](https://github.com/NousResearch/hermes-agent/commit/ba96e68d475bbdbe698fbb806d0573ea69c3b104): fix(tools): search_files treats a JSON-null path like a blank one
- [`d77cf5ae51`](https://github.com/NousResearch/hermes-agent/commit/d77cf5ae5190d5dc321a036f6b48bdc2fdf22edf): fix(tools): search_files only defaults None/blank paths, not wrong-typed ones
- [`7b57cda6d9`](https://github.com/NousResearch/hermes-agent/commit/7b57cda6d9adf87b2580da0222db9159c412b810): fix(agent): redact dotted and Zhipu API keys
- [`c2aa2ff25f`](https://github.com/NousResearch/hermes-agent/commit/c2aa2ff25f0096744aeb4bdc618b4f0cbdd3d305): fix(redact): dotted sk- pattern without nested repeats; tests cover terminal + file_read surfaces
- [`aebc71d78c`](https://github.com/NousResearch/hermes-agent/commit/aebc71d78c703923656f2d0554d3abc93fc1c511): fix(redact): dotted sk- body cannot span "..", so display masks survive a second pass; Zhipu matcher is 32-hex.16+alnum
- [`70f79c8cde`](https://github.com/NousResearch/hermes-agent/commit/70f79c8cde3c304c73345e15c96f1fff3d2846f5): fix(agent): anchor the Telegram token regex to a digit-run start (ReDoS)
- [`5c305fa9e0`](https://github.com/NousResearch/hermes-agent/commit/5c305fa9e05522b286553d25eb60a1cb034b7fa5): fix(agent): count tool-call argument brackets outside strings and close in stack order
- [`081332f0ee`](https://github.com/NousResearch/hermes-agent/commit/081332f0ee2237abfe69c5f9710ac531f77f752a): fix: repair misnested tool-call closers by inserting the missing one before the misplaced one
- [`8e3d540534`](https://github.com/NousResearch/hermes-agent/commit/8e3d540534c1f887b2d4387e1354e391ca461415): fix(mcp): propagate dashboard OAuth flow errors to the callback waiter
- [`4ab7dec756`](https://github.com/NousResearch/hermes-agent/commit/4ab7dec7562dc05d3f2d46b03be98877610b22df): fix(compaction): name the emitted task heading in the update instruction
- [`e113c1b3af`](https://github.com/NousResearch/hermes-agent/commit/e113c1b3aff3d9248ee1209f4f31cc74f49761c5): fix(video_gen): build the OpenAI-compatible video client on the env-only-proxy httpx client
- [`236aab3e8f`](https://github.com/NousResearch/hermes-agent/commit/236aab3e8f13ee93f10fbc82ab2ba6841f68152a): fix(auxiliary): recognise Gemini's structured-output 400 wording
- [`3ca79fd771`](https://github.com/NousResearch/hermes-agent/commit/3ca79fd771f1a252d34eca079a6fe53918d04c3d): fix: codex app-server crash text reaches the user when stderr lags the exit (#121467)
- [`e70fbbe3ec`](https://github.com/NousResearch/hermes-agent/commit/e70fbbe3ec43af8e3561a19dd035443f8082fcfa): fix(debug): redact the system dump in debug share and gateway /debug
- [`205d5d78f1`](https://github.com/NousResearch/hermes-agent/commit/205d5d78f1ff8a20701555bff26e107df48d5b92): fix(debug): strict URL-credential redaction for the system dump
- [`cf94e3eea3`](https://github.com/NousResearch/hermes-agent/commit/cf94e3eea31e28be877f98e3d9773f95be8ee15c): fix(redact): GCS and Azure SAS signatures count as URL credentials
- [`f907520593`](https://github.com/NousResearch/hermes-agent/commit/f907520593512545a213c6dbc127e02d2d6ce3d4): fix(debug): mask fallback api_key by field, whatever its YAML shape
- [`536802c00e`](https://github.com/NousResearch/hermes-agent/commit/536802c00e4f93061fc46b134dc029ff695f364f): fix(debug): mask every secret fallback field per agent.redact policy, not only api_key
- [`00227371f2`](https://github.com/NousResearch/hermes-agent/commit/00227371f27d4b5027844aa105ded0d84a412f11): fix(agent): redact strict URL userinfo credentials
- [`c900b1df58`](https://github.com/NousResearch/hermes-agent/commit/c900b1df58ee9f8b91142719ff29c4a3269e3a09): refactor(agent): simplify strict URL userinfo substitution
- [`ba5bec3f2c`](https://github.com/NousResearch/hermes-agent/commit/ba5bec3f2c9ae2eceac81d3dc6841e67b808adf3): fix(tui-gateway): a stale session_id no longer turns config.set fast/yolo global
- [`6c2a94f4b6`](https://github.com/NousResearch/hermes-agent/commit/6c2a94f4b634dbbdce09e5ff26b88bcfbd845198): fix(tui-gateway): stale session_id is refused once at the config.set seam for every session-scoped key
- [`47668280e7`](https://github.com/NousResearch/hermes-agent/commit/47668280e793ce14e352747d794d7ef719d93ca0): fix(redact): mask secrets in Python mapping reprs
- [`e166791f9f`](https://github.com/NousResearch/hermes-agent/commit/e166791f9ffbb825a75aa41f6c447e5cb14fc6d0): fix(mcp): treat a non-object client.json as corrupt instead of crashing auth init
- [`85188b47f7`](https://github.com/NousResearch/hermes-agent/commit/85188b47f7c31aaab4537434f7a3d2d10cb5f948): fix(skills-guard): make the AWS key pattern case-sensitive
- [`0dfb5082b7`](https://github.com/NousResearch/hermes-agent/commit/0dfb5082b78626c0a3343a91986ef427e3885780): fix(tts): drop unterminated <think> tail on streaming chunker flush (#73962)
- [`a1e10501f6`](https://github.com/NousResearch/hermes-agent/commit/a1e10501f64c9d0845e587e6f7e80fee1a1fe4b2): fix(tts): keep the Gemini API key out of request URLs
- [`8305113328`](https://github.com/NousResearch/hermes-agent/commit/8305113328b3625311b346102221ad552ae2271b): fix(compression): don't mistake a worker's TimeoutError for a poll timeout
- [`e2e2a2fb43`](https://github.com/NousResearch/hermes-agent/commit/e2e2a2fb4304503d496f4e7cd8c1783b272a2b57): fix(process): kill children a SIGTERM-ignoring background shell spawns during the grace window
- [`a28e13b6e6`](https://github.com/NousResearch/hermes-agent/commit/a28e13b6e647a999bace538bf52b8596d2822018): fix(tui_gateway): bind the session cwd around manual /compress
